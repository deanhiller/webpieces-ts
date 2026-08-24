import {
    BuildsLog, HomeConfigService, Option, RepoRootFinder, RuleFailError, RunningBuild,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { BUILD_STAGE } from '../workflow/build-gate-log';

/** The rule name the refusal is reported under, so it is greppable from a transcript. */
export const TOO_MANY_CONCURRENT_BUILDS = 'too-many-concurrent-builds';

/**
 * What `wp-build` was asked to do. Data-only (a class, per CLAUDE.md), with exactly one field so far.
 *
 * `force` SKIPS THE CONCURRENCY CHECK AND NOTHING ELSE. It does not touch the command, and it must never
 * grow a field that does: `wp-build` runs `commands.pr-gate.buildCommand` verbatim, and a flag that
 * changed the command would make it a different build from the one the PR gate runs — which is the exact
 * drift this bin exists to delete.
 */
export class BuildOptions {
    force: boolean;

    // REQUIRED, no default. `new BuildOptions()` and `new BuildOptions(false)` would be two spellings of
    // one decision, and the bare form would keep compiling unchanged if this class ever grew a second
    // field — silently meaning "not forced" at a call site that was never revisited. That is the same
    // argument HomeConfig's constructor makes about its own four required parameters; a defaulted
    // parameter is exactly the shim this repo does not ship.
    constructor(force: boolean) {
        this.force = force;
    }
}

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
 * (`resolveBuildCommand`), announces it, runs it, captures its output to a log file, and renders the
 * failure. `wp-build` calls THAT — it does not re-read the config key and does not hand-write a second
 * failure string. A second reader is a second thing that can drift, and a second failure message is a
 * second thing that can teach a command the gate does not run; drift is the entire reason this bin
 * exists, so reproducing it one level in would be self-defeating.
 *
 * Only `BuildGateOptions` differs from stage ② and stage ③ — the label, the command to re-run, the
 * headline, and the log-file stage id.
 *
 * ─── The output goes to a FILE, unconditionally ────────────────────────────────────────────────────
 * Every caller of the gate captures, and there is no flag or config key that selects otherwise. That is
 * the reason this bin is worth running: the build's full stdout+stderr land in `.webpieces/build.log`
 * (previous run kept as `.webpieces/build.log.bak`), and the console gets a heartbeat plus a pointer at
 * that file. A measured session burned ~19 minutes re-running `nx affected` five times with no code
 * change in between, purely to see a different slice of output that had scrolled past. Reading a
 * different slice must cost a `grep`, not a build — see BuildGateLog.
 */
@injectable(bindingScopeValues.Singleton)
export class BuildCommand {
    constructor(
        private readonly buildAffected: BuildAffected,
        private readonly repoRootFinder: RepoRootFinder,
        private readonly buildsLog: BuildsLog,
        private readonly homeConfig: HomeConfigService,
    ) {}

    run(opts: BuildOptions): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        if (!opts.force) this.assertMachineHasRoom();
        // runBuildGate announces the resolved command, runs it, and throws CliExitError on failure so
        // runMain owns the exit — the same three things it does for stage ② and stage ③. It also writes
        // this build's START/DONE pair to the ledger the check above just read.
        return this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '🛠️  wp-build',
            'pnpm wp-build',
            'Build failed.',
            BUILD_STAGE,
        ));
    }

    /**
     * Refuse when this MACHINE is already running `maxConcurrentBuilds` builds.
     *
     * ─── WHY ONLY HERE, AND NEVER ON THE GATE STAGES ─────────────────────────────────────────────────
     * `wp-review-upsert-pr` and `wp-finish-upsert-pr` are the SANCTIONED path, and a refusal there wedges
     * a PR that has nowhere else to go. So they always run — and their builds still write ledger rows, so
     * they count toward what refuses an ad-hoc `wp-build`. The asymmetry is the whole design: the thing
     * that gets throttled is the extra build, not the one the process needs.
     *
     * The cures are `Option`s handed to `RuleFailError`, which `runMain` renders through
     * `formatFixOptions`. They are never numbered by hand in the message — the framework owns
     * "Fix Option N:", and a hand-numbered list in a string literal is an automatic review reject.
     */
    private assertMachineHasRoom(): void {
        const live = this.buildsLog.running();
        const max = this.homeConfig.load().maxConcurrentBuilds;
        if (live.length < max) return;
        throw new RuleFailError(
            TOO_MANY_CONCURRENT_BUILDS,
            `This machine is already running ${String(live.length)} build(s), and the limit is ` +
            `${String(max)}. Starting another makes all of them slower — CPU contention between agents ` +
            `building at once was measured at ~3.2x total test time.\n\n${this.describe(live)}`,
            undefined,
            undefined,
            [
                new Option(
                    'Re-use the gate you should be running anyway: `pnpm wp-start-upsert-pr` then\n'
                    + '`pnpm wp-review-upsert-pr`. Stage ② runs the SAME `commands.pr-gate.buildCommand`\n'
                    + 'this would have run, so its green is the same evidence — and it posts the PR.',
                    true),
                new Option(
                    'Wait for one of the builds above to finish and run `pnpm wp-build` again. A build\n'
                    + 'that has already died leaves no row: the count only holds live processes.'),
                new Option(
                    'Verify only what you are editing instead of the whole affected set:\n'
                    + '`pnpm exec vitest run <one spec file>`, or `pnpm nx run <project>:test`.'),
                new Option(
                    'Raise the limit for THIS machine, if it genuinely has the cores: put\n'
                    + '`{"experimental": {"maxConcurrentBuilds": <n>}}` in `~/.webpieces/config.json`.'),
                new Option(
                    'If you are really stuck and cannot use a gate and really really need wp-build\n'
                    + 'then use `pnpm wp-build --force`.'),
            ],
        );
    }

    // One line per live build: which repo, which worktree, on what branch, and how long it has been
    // going. Age is what tells a reader whether to wait thirty seconds or go and look at a stuck agent.
    private describe(live: readonly RunningBuild[]): string {
        return live.map((build: RunningBuild): string => {
            const age = Math.max(0, Math.round((Date.now() - build.startedMs) / 1000));
            return `  • ${build.repo} [tree=${build.tree || 'primary'}] `
                + `branch=${build.branch || '?'} by=${build.by} pid=${String(build.pid)} `
                + `running for ${String(age)}s`;
        }).join('\n');
    }
}
