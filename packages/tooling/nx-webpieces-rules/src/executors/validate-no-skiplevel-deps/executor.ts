/**
 * Validate No Skip-Level Dependencies Executor — RETIRED (no-op).
 *
 * Skip-level (redundant transitive) edges used to be an error here. That is no longer
 * meaningful: `architecture:generate` now derives the graph from nx's project graph and
 * applies transitive reduction, so the committed architecture/dependencies.json can never
 * contain a redundant edge. The check is superseded by auto-reduction.
 *
 * Worse, its old remediation told users to remove "redundant" deps from package.json —
 * which is exactly the runtime-validity trap (a transitively-reachable package.json entry
 * can still be a real runtime dependency, e.g. a peerDependency or generated client).
 *
 * Defaults off (workspace.validations.noSkipLevelDeps=false). Kept as a no-op for one
 * release so any explicit enablement does not error on now-expected skip-level edges.
 *
 * Usage:
 * nx run architecture:validate-no-skiplevel-deps
 */

import type { ExecutorContext } from '@nx/devkit';

export interface ValidateNoSkipLevelDepsOptions {
    // No options needed
}

export interface ExecutorResult {
    success: boolean;
}

export default async function runExecutor(
    _options: ValidateNoSkipLevelDepsOptions,
    _context: ExecutorContext
): Promise<ExecutorResult> {
    console.log(
        '\n⏭️  validate-no-skiplevel-deps is retired (no-op).\n' +
            '   Superseded by auto-reduction in `architecture:generate`: the committed graph is\n' +
            '   transitively reduced, so skip-level edges cannot occur.\n'
    );
    return { success: true };
}
