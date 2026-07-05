/**
 * Graph Metadata Enrichment
 *
 * Fills the AI-oriented fields on each architecture/dependencies.json entry:
 *   framework            — from `framework:<x>` nx tag or package.json inference
 *   shortDescription     — first paragraph of the project's responsibilities.md
 *   responsibilitiesFile — repo-relative path to the required responsibilities.md
 *   designFile           — repo-relative path to the generated DI design.json
 *
 * Validation is aggregated: ALL problems across ALL projects are collected and
 * thrown as one MetadataValidationError so a repo adopting this sees the full
 * seeding list in a single run. Callers must enrich BEFORE writing any file so
 * a failed run never clobbers dependencies.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createProjectGraphAsync } from '@nx/devkit';
import type { EnhancedGraph } from './graph-sorter';
import { ProjectInfo } from './project-info';
import { resolveFramework } from './framework-resolver';
import { resolveRole } from './role-resolver';
import { extractShortDescription, validateShortDescription } from './responsibilities';

export const RESPONSIBILITIES_FILE_NAME = 'responsibilities.md';

/**
 * Thrown when one or more projects fail metadata validation (missing/invalid
 * responsibilities.md, bad framework tags, ...). Executors catch this to point
 * AI at the webpieces.responsibilities.md instructions template.
 */
export class MetadataValidationError extends Error {
    constructor(public readonly problems: string[]) {
        super(
            `Architecture metadata validation failed (${problems.length} problem(s)):\n` +
                problems.map((problem: string) => `  - ${problem}`).join('\n')
        );
        this.name = 'MetadataValidationError';
    }
}

/**
 * Read per-project root + tags from nx's project graph.
 */
export async function collectProjectInfo(): Promise<Map<string, ProjectInfo>> {
    const projectGraph = await createProjectGraphAsync();
    const infos = new Map<string, ProjectInfo>();
    for (const [name, node] of Object.entries(projectGraph.nodes)) {
        infos.set(name, new ProjectInfo(name, node.data.root, node.data.tags ?? []));
    }
    return infos;
}

/**
 * Enrich every graph entry in place with framework, shortDescription,
 * responsibilitiesFile and designFile. Throws MetadataValidationError listing
 * every problem when any project fails validation.
 */
export function enrichGraph(
    graph: EnhancedGraph,
    infos: Map<string, ProjectInfo>,
    workspaceRoot: string
): void {
    const problems: string[] = [];

    for (const [projectName, entry] of Object.entries(graph)) {
        const info = infos.get(projectName);
        if (!info) {
            problems.push(`${projectName}: not found in nx project graph`);
            continue;
        }

        const resolution = resolveFramework(info, workspaceRoot);
        if (resolution.problem !== null) {
            problems.push(resolution.problem);
        } else if (resolution.framework !== null) {
            entry.framework = resolution.framework;
        }

        const roleResolution = resolveRole(info);
        if (roleResolution.problem !== null) {
            problems.push(roleResolution.problem);
        } else if (roleResolution.role !== null) {
            entry.role = roleResolution.role;
        }

        enrichResponsibilities(entry, info, workspaceRoot, problems);

        // Only project.json projects get a generated design.json (see di-graph-targets.ts)
        if (fs.existsSync(path.join(workspaceRoot, info.root, 'project.json'))) {
            entry.designFile = toRepoRelative(info.root, 'design.json');
        }
    }

    validateLibraryTypesMatch(graph, problems);
    validateRoleDependencies(graph, problems);

    if (problems.length > 0) {
        throw new MetadataValidationError(problems);
    }
}

/**
 * Roles that are terminal APPS — nothing may depend on them. A server or a
 * client is a top-level runnable; being depended upon means it is really a
 * library and should be retagged `role:lib`/`role:designed-lib`.
 */
export const APP_ROLES: ReadonlyArray<string> = ['server', 'client'];

/**
 * libType usable by any side — a dependency of this type is always allowed.
 */
export const ALL_LIB_TYPE = 'all';

/**
 * `library-types-match-client` rule.
 *
 * A project's `framework` field is its libType — which client side it targets
 * (angular | react | express | all). This keeps side-specific code from
 * crossing sides: an `express` project must not pull in an `angular`-only
 * library (and vice-versa), and an `all` library — one that claims to be usable
 * by everyone — must not depend on a side-specific library (which would quietly
 * make it un-usable by the other sides).
 *
 * For every dependency edge A → B: allowed iff B is `all` or B has the same
 * libType as A. Every violation is appended to `problems` so `arch:generate`
 * fails with the full list.
 */
export function validateLibraryTypesMatch(graph: EnhancedGraph, problems: string[]): void {
    for (const [projectName, entry] of Object.entries(graph)) {
        const fromType = entry.framework;
        if (fromType === undefined) continue; // framework resolution already flagged this project

        for (const dep of entry.dependsOn) {
            const depEntry = graph[dep];
            const toType = depEntry?.framework;
            if (toType === undefined) continue;

            if (toType === ALL_LIB_TYPE || toType === fromType) continue;

            problems.push(
                `library-types-match-client: '${projectName}' (${fromType}) must not depend on ` +
                    `'${dep}' (${toType}) — a '${fromType}' project may depend only on '${fromType}' ` +
                    `or '${ALL_LIB_TYPE}' libraries. Fix the tag on one of them (framework:<angular|react|express|all>) ` +
                    `or remove the dependency.`
            );
        }
    }
}

/**
 * `role-dependency` rule.
 *
 * A project's `role` is its function (server | designed-lib | lib | client).
 * Apps are terminal — libraries and clients consume them, never the reverse:
 *   - a `client` is fully terminal: NOTHING may depend on it.
 *   - a `server` may only be depended upon by another `server` — the one
 *     legitimate case is a server-side orchestrator/e2e harness that boots
 *     other servers. A `lib`/`designed-lib`/`client` depending on a `server`
 *     inverts the dependency direction and is a violation.
 */
export function validateRoleDependencies(graph: EnhancedGraph, problems: string[]): void {
    for (const [projectName, entry] of Object.entries(graph)) {
        const fromRole = entry.role;
        for (const dep of entry.dependsOn) {
            const toRole = graph[dep]?.role;
            if (toRole === undefined) continue; // role resolution already flagged this project
            if (!APP_ROLES.includes(toRole)) continue;
            // A server may orchestrate/boot other servers (e.g. an e2e harness).
            if (toRole === 'server' && fromRole === 'server') continue;

            const why =
                toRole === 'client'
                    ? `a 'client' app is terminal and may never be depended upon`
                    : `a 'server' may only be depended upon by another 'server' (an orchestrator/e2e harness)`;
            problems.push(
                `role-dependency: '${projectName}' (role:${fromRole ?? 'none'}) must not depend on ` +
                    `'${dep}' (role:${toRole}) — ${why}. Retag '${dep}' role:lib/role:designed-lib if it ` +
                    `is actually a library, or remove the dependency.`
            );
        }
    }
}

function enrichResponsibilities(
    entry: EnhancedGraph[string],
    info: ProjectInfo,
    workspaceRoot: string,
    problems: string[]
): void {
    const responsibilitiesFile = toRepoRelative(info.root, RESPONSIBILITIES_FILE_NAME);
    entry.responsibilitiesFile = responsibilitiesFile;

    const absolutePath = path.join(workspaceRoot, info.root, RESPONSIBILITIES_FILE_NAME);
    if (!fs.existsSync(absolutePath)) {
        problems.push(
            `${info.name}: missing required ${responsibilitiesFile} — create it with a heading, ` +
                `one short summary paragraph, then the full responsibilities of the module`
        );
        return;
    }

    const summary = extractShortDescription(fs.readFileSync(absolutePath, 'utf-8'));
    const summaryProblem = validateShortDescription(summary, responsibilitiesFile);
    if (summaryProblem !== null) {
        problems.push(`${info.name}: ${summaryProblem}`);
        return;
    }
    entry.shortDescription = summary;
}

/**
 * Repo-relative path with forward slashes (stable across platforms in the
 * committed JSON).
 */
function toRepoRelative(projectRoot: string, fileName: string): string {
    return [projectRoot.replace(/\\/g, '/').replace(/\/+$/, ''), fileName].join('/');
}
