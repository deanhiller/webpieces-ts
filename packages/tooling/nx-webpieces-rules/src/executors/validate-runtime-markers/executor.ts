/**
 * Validate Runtime Markers Executor (per-project)
 *
 * Validates ONE service's `live.json` against its actual api-project
 * dependencies (from the Nx graph), independently of all other projects:
 *
 *   set(api-project deps) === set(implements ∪ uses declared in live.json)
 *
 * - An api-project dependency not declared in live.json  -> FAIL (undeclared).
 * - A live.json entry that is not an actual api dependency -> FAIL (phantom).
 * - A service with api deps but no live.json               -> FAIL (missing).
 *
 * On/off + a whole-rule grace window come from webpieces.config.json
 * (rule: runtime-architecture). Api projects are exempt (they are contracts).
 *
 * Usage: nx run <project>:validate-runtime-markers
 */

import type { ExecutorContext } from '@nx/devkit';
import { buildWorkspaceModel, readLiveMarker, resolvePackageNames } from '../../lib/runtime-markers';
import type { WorkspaceModel, ProjectInfo } from '../../lib/runtime-markers';
import { loadRuntimeConfig, isGraceActive, epochDate, RUNTIME_RULE_NAME } from '../../lib/runtime-config';

export interface ValidateRuntimeMarkersOptions {
    // Config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

function apiDepsOf(model: WorkspaceModel, info: ProjectInfo): string[] {
    return info.deps.filter((dep: string) => model.projects.get(dep)?.isApi === true).sort();
}

export default async function runExecutor(
    _options: ValidateRuntimeMarkersOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const workspaceRoot = context.root;
    const config = loadRuntimeConfig(workspaceRoot);

    if (config.off) {
        console.log(`\n⏭️  Skipping ${RUNTIME_RULE_NAME} markers (mode: OFF)\n`);
        return { success: true };
    }
    if (config.apiProjectPaths.length === 0) {
        return { success: true };
    }

    const projectName = context.projectName ?? '';
    const model = await buildWorkspaceModel(workspaceRoot, config.apiProjectPaths);
    const info = model.projects.get(projectName);
    if (!info || info.isApi) {
        return { success: true };
    }

    const violations = collectViolations(model, info, workspaceRoot);
    if (violations.length === 0) {
        console.log(`\n✅ ${projectName}: live.json matches api dependencies\n`);
        return { success: true };
    }

    console.error(`\n❌ ${projectName}: live.json does not match api dependencies:\n`);
    for (const v of violations) console.error(`  - ${v}`);
    console.error(`\nFix ${info.root}/live.json so "implements" ∪ "uses" equals the api projects in deps.\n`);

    if (isGraceActive(config.ignoreModifiedUntilEpoch)) {
        console.log(`⏳ Reported but not failing (ignoreModifiedUntilEpoch active, expires ${epochDate(config.ignoreModifiedUntilEpoch!)}).\n`);
        return { success: true };
    }
    return { success: false };
}

/** Bidirectional-exact comparison of api deps vs live.json declarations. */
function collectViolations(model: WorkspaceModel, info: ProjectInfo, workspaceRoot: string): string[] {
    const apiDeps = apiDepsOf(model, info);
    const marker = readLiveMarker(workspaceRoot, info.root);

    if (!marker) {
        if (apiDeps.length === 0) return [];
        return [`missing live.json (service depends on api projects: ${apiDeps.join(', ')})`];
    }

    const declaredNames = Array.from(new Set([...marker.implements, ...marker.uses]));
    const resolved = resolvePackageNames(model, declaredNames);
    const declaredProjects = new Set(resolved.projects);
    const apiDepSet = new Set(apiDeps);

    const violations: string[] = [];
    for (const pkg of resolved.unknown) {
        violations.push(`declared "${pkg}" which is not a workspace package`);
    }
    for (const proj of resolved.projects) {
        if (!model.projects.get(proj)?.isApi) {
            violations.push(`declared "${proj}" which is not an api project`);
        }
    }
    for (const dep of apiDeps) {
        if (!declaredProjects.has(dep)) violations.push(`api dependency "${dep}" is not declared in live.json`);
    }
    for (const proj of declaredProjects) {
        if (model.projects.get(proj)?.isApi && !apiDepSet.has(proj)) {
            violations.push(`live.json declares "${proj}" but it is not an actual dependency`);
        }
    }
    return violations;
}
