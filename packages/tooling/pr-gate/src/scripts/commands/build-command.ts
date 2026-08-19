import { CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { BuildAffected } from '../workflow/build-affected';

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
 * ─── ONE resolver ──────────────────────────────────────────────────────────────────────────────────
 * `BuildAffected.resolveBuildCommand` is the single code path that answers "what is this repo's build
 * command", and it is already the one the gate's own build stage calls. `wp-build` calls THAT rather
 * than re-reading the config key, because a second reader is a second thing that can drift — and drift
 * is the entire reason this bin exists.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildCommand {
    constructor(
        private readonly buildAffected: BuildAffected,
        private readonly repoRootFinder: RepoRootFinder,
    ) {}

    run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        // Resolved through the gate's own resolver, then printed, so what ran is on the transcript and
        // an agent reading back can see WHICH command produced the result it is looking at.
        const buildCommand = this.buildAffected.resolveBuildCommand(repoRoot);
        process.stdout.write(`\n▶ wp-build: ${buildCommand}\n\n`);
        const code = this.buildAffected.runBuildAffected(repoRoot, buildCommand);
        if (code !== 0) {
            throw new CliExitError(code,
                '\n❌ Build failed.\n\n' +
                'Fix the errors above and re-run:\n\n' +
                '    pnpm wp-build\n\n' +
                'Narrower while you iterate: pnpm nx run <project>:ci, or pnpm exec vitest run <path>.\n');
        }
        process.stdout.write('\n✅ Build passed.\n');
        return Promise.resolve();
    }
}
