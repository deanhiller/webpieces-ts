import { RepoRootFinder } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { BUILD_STAGE } from '../workflow/build-gate-log';

/**
 * `wp-build` — run THE project's build, and nothing else.
 *
 * ─── Why this bin exists ───────────────────────────────────────────────────────────────────────────
 * The correct verification command has lived in `commands.pr-gate.buildCommand` all along, and NOTHING
 * SURFACED IT. So every repo hand-composed its own verify chain, and those chains drifted: one sibling
 * repo's `ci:local` was `prettier --check .` (whole repo) + `wp-ci` (whole monorepo) +
 * `nx affected -t test` with NO `--base` (whole repo again) — three whole-world passes on an inner
 * loop, none of them the command the gate runs. `wp-build` closes that by making the configured value
 * the only thing anyone has to type.
 *
 * ─── It composes NOTHING, deliberately ─────────────────────────────────────────────────────────────
 * This command runs `commands.pr-gate.buildCommand` VERBATIM and adds no leg of its own — no format
 * check, no lint pass, no extra test run. Composition is exactly what drifted. Anything that must run
 * on every build belongs INSIDE `buildCommand`, where the PR gate runs it too; a leg added here would
 * be a leg the gate never sees, which is the same defect one level in.
 *
 * ─── ONE resolver, and ONE gate ────────────────────────────────────────────────────────────────────
 * `BuildAffected.runBuildGate` is the single code path that resolves the command
 * (`resolveBuildCommand`), announces it, runs it, honours `buildGateLogCapture`, and renders the
 * failure. `wp-build` calls THAT — it does not re-read the config key and does not hand-write a second
 * failure string. A second reader is a second thing that can drift, and a second failure message is a
 * second thing that can teach a command the gate does not run; drift is the entire reason this bin
 * exists, so reproducing it one level in would be self-defeating.
 *
 * Only `BuildGateOptions` differs from stage ② and stage ③ — the label, the command to re-run, the
 * headline, and the log-file stage id.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildCommand {
    constructor(
        private readonly buildAffected: BuildAffected,
        private readonly repoRootFinder: RepoRootFinder,
    ) {}

    run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // runBuildGate announces the resolved command, runs it, and throws CliExitError on failure so
        // runMain owns the exit — the same three things it does for stage ② and stage ③.
        this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '🛠️  wp-build',
            'pnpm wp-build',
            'Build failed.',
            BUILD_STAGE,
        ));
        return Promise.resolve();
    }
}
