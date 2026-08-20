import { spawnSync } from 'child_process';
import {
    loadAndValidate, CliExitError, HomeConfigService, DEFAULT_BUILD_COMMAND, BuildsLog,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { BuildGateLog } from './build-gate-log';

// Single source of truth for RUNNING the build gate. `wp-start-upsert-pr` runs NO build; stage ②
// (`wp-review-upsert-pr`) runs it authoritatively before any reviewer is spawned, and stage ③
// (`wp-finish-upsert-pr`) re-runs it only when HEAD has moved since. nx `affected` only rebuilds
// changed projects. The fallback command itself lives in @webpieces/rules-config as
// DEFAULT_BUILD_COMMAND — whole-repo-build-guard prints the same string, and one definition is what
// keeps the refusal message naming the build that actually runs.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The caller-supplied framing for the build gate (label, re-run command, failure headline, stage id). Kept
 * as a parameter object so runBuildGate stays agnostic of who invokes it. A class (not an object literal)
 * per the codebase's data-structure convention.
 */
export class BuildGateOptions {
    label: string;            // section header shown above the gate
    rerunCommand: string;     // command the AI re-runs after fixing the build
    failureHeadline: string;  // first line printed on failure
    // WHICH stage's gate this is — REVIEW_STAGE, FINISH_STAGE or BUILD_STAGE. Required, with no default:
    // it decides the captured log's filename, and a default would silently make two stages share one file.
    stage: string;
    // Capture regardless of the EXPERIMENTAL `~/.webpieces/config.json` opt-in. True for `wp-build`, whose
    // entire contract IS the log file — its console output is a heartbeat and a pointer at that file, so a
    // wp-build that did not capture would have nothing to point at. The PR-flow stages pass false and stay
    // on the opt-in until the experiment lands for them too.
    alwaysCapture: boolean;

    constructor(label: string, rerunCommand: string, failureHeadline: string, stage: string, alwaysCapture: boolean) {
        this.label = label;
        this.rerunCommand = rerunCommand;
        this.failureHeadline = failureHeadline;
        this.stage = stage;
        this.alwaysCapture = alwaysCapture;
    }
}

/** Runs the authoritative nx-affected build gate for wp-review-upsert-pr and wp-finish-upsert-pr. */
@injectable(bindingScopeValues.Singleton)
export class BuildAffected {
    constructor(
        private readonly homeConfig: HomeConfigService,
        private readonly buildLog: BuildGateLog,
        private readonly buildsLog: BuildsLog,
    ) {}

    /**
     * EXPERIMENTAL, and OFF unless the OPTIONAL machine-local `~/.webpieces/config.json` turns it on.
     *
     * That file does not exist for essentially anyone, and its absence is not an error, a warning or a
     * behaviour change of any kind — `HomeConfigService.load` returns all-defaults silently. False here is
     * therefore the state every consumer is in, and false means runBuildGate executes exactly the code it
     * executed before this feature existed.
     */
    isCaptureEnabled(): boolean {
        return this.homeConfig.load().buildGateLogCapture;
    }

    /**
     * Resolve the exact build command this gate will run: the project's configured
     * PrGateConfig.buildCommand, or the default affected-ci command when none is set.
     */
    resolveBuildCommand(repoRoot: string): string {
        const configured = loadAndValidate(repoRoot).prGate.buildCommand;
        return configured !== undefined && configured.trim() !== '' ? configured : DEFAULT_BUILD_COMMAND;
    }

    /**
     * Spawn the resolved build command, streamed to the terminal. Returns the exit code (0 = pass).
     *
     * PRIVATE, and that is the point. This and `runConfiguredBuildGate` used to be PUBLIC side doors that
     * spawned `buildCommand` with no caller identity and no ledger row — so "run the build" had three
     * spellings, two of which were invisible to `~/.webpieces/builds.log`. They are folded into this one
     * private method, reachable only through `runBuildGate`, which means an unlogged build no longer
     * COMPILES. That is the one-spelling rule from CLAUDE.md § "NO webpieces surface is released
     * backwards-compatible" applied to a behaviour rather than a type.
     *
     * Prints NOTHING itself — `runBuildGate` announces the command in one line.
     */
    private spawnBuild(repoRoot: string): number {
        const configured = loadAndValidate(repoRoot).prGate.buildCommand;
        const cmd = configured !== undefined && configured.trim() !== '' ? configured : DEFAULT_BUILD_COMMAND;
        const result = spawnSync(cmd, { stdio: 'inherit', cwd: repoRoot, shell: true });
        return result.status ?? 1;
    }

    /**
     * Run the configured build gate with consistent framing, throwing CliExitError(buildCode) on
     * failure so the bin's main()/runMain owns the exit. THE single source of truth for running a build:
     * wp-build, wp-review-upsert-pr and wp-finish-upsert-pr all call THIS (only the BuildGateOptions
     * differ), and there is no other way to reach the spawn.
     *
     * ─── EVERY BUILD ON THIS MACHINE IS LEDGERED FROM HERE ───────────────────────────────────────────
     * A START row goes into `~/.webpieces/builds.log` before the spawn and a DONE row after it, in a
     * `finally` so a throw on the failure path still closes the pair. `opts.stage` — `build` | `review` |
     * `finish` — IS the caller id the row records; there is deliberately no second `caller` field, since
     * two spellings of one fact is the shim CLAUDE.md rejects.
     *
     * The ledger is best-effort by construction (see BuildsLog): it can never throw, so no build can die
     * because a log file was busy.
     */
    async runBuildGate(repoRoot: string, opts: BuildGateOptions): Promise<void> {
        const buildCommand = this.resolveBuildCommand(repoRoot);
        // TWO lines on the happy path — the command, then the result. The old framing spent a banner and a
        // paragraph explaining how to reproduce a build that was about to pass anyway; that explanation is
        // only useful when the build FAILS, so it now lives solely on the failure path below.
        process.stdout.write(`\n${opts.label}: ${buildCommand}\n`);
        // '' means NOT capturing: a PR-flow stage on a machine that has not created the OPTIONAL
        // `~/.webpieces/config.json`. Everything below then runs exactly the code it ran before capture
        // existed — same spawn, streamed to the terminal, same message, no extra file.
        const logPath = opts.alwaysCapture || this.isCaptureEnabled() ? this.buildLog.pathFor(repoRoot, opts.stage) : '';
        const ticket = this.buildsLog.start(opts.stage, repoRoot);
        let buildCode = 1;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the DONE row must be written whether the
        // build passed, failed, or the spawn itself blew up; the throw is re-raised untouched below
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            buildCode = logPath === ''
                ? this.spawnBuild(repoRoot)
                : await this.buildLog.run(repoRoot, buildCommand, logPath);
        } finally {
            this.buildsLog.finish(ticket, buildCode);
        }
        if (buildCode !== 0) throw new CliExitError(buildCode, this.failureText(opts, buildCommand, logPath));
        process.stdout.write(logPath === '' ? '\n✅ Build passed.\n' : this.buildLog.successMessage(logPath));
    }

    /**
     * On failure, WITHOUT capture: the pre-existing text, which tells the AI to re-run the build itself.
     * WITH capture: a deliberately tiny pointer at the log the gate already wrote — the whole point of the
     * feature is that the agent reads one file instead of rebuilding the repo and eating the transcript.
     */
    private failureText(opts: BuildGateOptions, buildCommand: string, logPath: string): string {
        if (logPath !== '') return this.buildLog.failureMessage(buildCommand, logPath);
        return `\n❌ ${opts.failureHeadline}\n\n` +
            `Run THIS exact command to reproduce and fix all errors, then re-run ${opts.rerunCommand}:\n\n` +
            `    ${buildCommand}\n`;
    }
}
