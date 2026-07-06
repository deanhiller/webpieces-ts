/**
 * Validate DI Graph Unchanged Executor
 *
 * Per-project gate that runs AFTER di-graph-generate (via target dependsOn):
 * once the generator has rewritten design.json/design.md/design.html, this
 * executor asks git whether the files differ from the committed copies. Any difference —
 * modified OR brand-new/untracked — fails the build with a "commit the
 * regenerated files" remediation, so the checked-in DI design DAG can never
 * go stale on main.
 *
 * Uses `git status --porcelain` (not `git diff --quiet`) so first-time
 * untracked design files also fail CI instead of slipping through.
 *
 * Config (webpieces.config.json, rule key `di-graph`): mode OFF disables;
 * ignoreModifiedUntilEpoch / ignoreRuleWhileOnBranch report but pass.
 *
 * Usage: nx run <project>:validate-di-graph-unchanged
 */

import type { ExecutorContext } from '@nx/devkit';
import { loadAndValidate, shouldSkipRule } from '@webpieces/rules-config';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { toError } from '../../toError';

export interface ValidateDiGraphUnchangedOptions {
    // No options here — config comes from webpieces.config.json at runtime.
}

export interface ExecutorResult {
    success: boolean;
}

const RULE_NAME = 'di-graph';
const DESIGN_FILES = ['design.json', 'design.md', 'design.html'];

function gitStatusPorcelain(workspaceRoot: string, projectRoot: string): string {
    const paths = DESIGN_FILES.map((file: string) => path.posix.join(projectRoot, file));
    const output = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
        cwd: workspaceRoot,
        encoding: 'utf-8',
    });
    return output.trim();
}

function reportStale(projectName: string, projectRoot: string, status: string): void {
    console.error(`\n❌ DI design graph is stale for ${projectName}!`);
    console.error('\nThe regenerated design files differ from the committed copies:');
    for (const line of status.split('\n')) {
        console.error(`   ${line}`);
    }
    console.error('\nThe DI dependency DAG changed (a constructor/binding was added, removed,');
    console.error('or rewired). To fix:');
    console.error(`  1. Review the diff: git diff -- ${projectRoot}/design.json ${projectRoot}/design.md ${projectRoot}/design.html`);
    console.error('  2. If intentional, commit the regenerated design.json + design.md + design.html');
    console.error(`  3. To turn this gate off, set rules["${RULE_NAME}"].mode="OFF" in webpieces.config.json\n`);
}

export default async function runExecutor(
    _options: ValidateDiGraphUnchangedOptions,
    context: ExecutorContext,
): Promise<ExecutorResult> {
    const shared = loadAndValidate(context.root).resolved;
    const rule = shared.rules.get(RULE_NAME);
    if (rule && rule.isOff) {
        console.log(`\n⏭️  Skipping validate-di-graph-unchanged (mode: OFF)\n`);
        return { success: true };
    }

    const projectName = context.projectName ?? 'project';
    const projectConfig = context.projectsConfigurations?.projects[projectName];
    const projectRoot = projectConfig?.root ?? '.';

    console.log(`\n🔍 Validating DI design graph unchanged for ${projectName}\n`);

    let status: string;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- chokepoint: outside a git repo the gate warns and passes instead of crashing the build
    try {
        status = gitStatusPorcelain(context.root, projectRoot);
    } catch (err: unknown) {
        const error = toError(err);
        console.warn(`⚠️  Could not check git status (${error.message}) — skipping gate`);
        return { success: true };
    }

    if (status === '') {
        console.log('✅ DI design graph matches the committed design.json/design.md\n');
        return { success: true };
    }

    reportStale(projectName, projectRoot, status);

    const epoch = rule?.options['ignoreModifiedUntilEpoch'] as number | undefined;
    const branch = rule?.options['ignoreRuleWhileOnBranch'] as string | undefined;
    const skip = shouldSkipRule(epoch, branch);
    if (skip.skip) {
        console.log(`⏳ ${RULE_NAME}: ${skip.reason}. Staleness reported but NOT failing the build.\n`);
        return { success: true };
    }
    return { success: false };
}
