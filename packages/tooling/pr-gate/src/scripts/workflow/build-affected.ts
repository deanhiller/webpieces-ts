import {
    loadAndValidate, CliExitError, DEFAULT_BUILD_COMMAND, BuildsLog, RuleFailError,
} from '@webpieces/rules-config';
import { CodexGuardPresence, GuardPresenceVerdict } from '@webpieces/ai-hook-rules';
import { injectable, bindingScopeValues } from 'inversify';
import { BuildGateLog } from './build-gate-log';
import { StageOutputLog } from './stage-output-log';

// Single source of truth for RUNNING the build gate. `wp-start-upsert-pr` runs NO build; stage ②
// (`wp-review-upsert-pr`) runs it authoritatively before any reviewer is spawned, and stage ③
// (`wp-finish-upsert-pr`) re-runs it only when HEAD has moved since. nx `affected` only rebuilds
// changed projects. The fallback command itself lives in @webpieces/rules-config as
// DEFAULT_BUILD_COMMAND — whole-repo-build-guard prints the same string, and one definition is what
// keeps the refusal message naming the build that actually runs.


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

    constructor(label: string, rerunCommand: string, failureHeadline: string, stage: string) {
        this.label = label;
        this.rerunCommand = rerunCommand;
        this.failureHeadline = failureHeadline;
        this.stage = stage;
    }
}

/**
 * The rule name the guard-presence refusal is reported under, so it is greppable from a transcript the
 * same way `too-many-concurrent-builds` is.
 */
export const CODEX_GUARDS_NEVER_RAN = 'codex-guards-never-ran';

/** Runs the authoritative nx-affected build gate for wp-review-upsert-pr and wp-finish-upsert-pr. */
@injectable(bindingScopeValues.Singleton)
export class BuildAffected {
    constructor(
        private readonly buildLog: BuildGateLog,
        private readonly buildsLog: BuildsLog,
        private readonly stageConsole: StageOutputLog,
        private readonly guardPresence: CodexGuardPresence,
    ) {}

    /**
     * Resolve the exact build command this gate will run: the project's configured
     * PrGateConfig.buildCommand, or the default affected-ci command when none is set.
     */
    resolveBuildCommand(repoRoot: string): string {
        const configured = loadAndValidate(repoRoot).prGate.buildCommand;
        return configured !== undefined && configured.trim() !== '' ? configured : DEFAULT_BUILD_COMMAND;
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
     * two spellings of one fact is the shim `.claude/rules/no-backwards-compat.md` rejects.
     *
     * The ledger is best-effort by construction (see BuildsLog): it can never throw, so no build can die
     * because a log file was busy.
     */
    async runBuildGate(repoRoot: string, opts: BuildGateOptions): Promise<void> {
        this.assertGuardsRan(repoRoot);
        const buildCommand = this.resolveBuildCommand(repoRoot);
        // TWO lines on the happy path — the command, then the result. The old framing spent a banner and a
        // paragraph explaining how to reproduce a build that was about to pass anyway; that explanation is
        // only useful when the build FAILS, so it now lives solely on the failure path below.
        //
        // `say`, so it survives a stage that is capturing its own console (see StageOutputLog): the
        // command being run and the result of running it are exactly what a caller watching a long build
        // needs to see live.
        this.stageConsole.say(`\n${opts.label}: ${buildCommand}\n`);
        const logPath = this.buildLog.pathFor(repoRoot, opts.stage);
        const ticket = this.buildsLog.start(opts.stage, repoRoot);
        let buildCode = 1;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the DONE row must be written whether the
        // build passed, failed, or the spawn itself blew up; the throw is re-raised untouched below
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            buildCode = await this.buildLog.run(repoRoot, buildCommand, logPath);
        } finally {
            this.buildsLog.finish(ticket, buildCode);
        }
        if (buildCode !== 0) throw new CliExitError(buildCode, this.failureText(opts, buildCommand, logPath));
        this.stageConsole.say(this.buildLog.successMessage(logPath));
    }

    /**
     * Refuse when this is a Codex session in which NOT ONE guard has run.
     *
     * ─── Why it lives at the build, and why in THIS method ───────────────────────────────────────────
     * `runBuildGate` is the single chokepoint every build reaches — `wp-build`, stage ② and stage ③ —
     * so one call here is the whole wiring. It runs BEFORE the command is resolved and before the
     * ledger row opens, because a session that was never guarded should cost nothing, not a full build
     * followed by a refusal to believe it.
     *
     * The build is the right MOMENT because it is where a session's work is first claimed as verified.
     * An unguarded Codex session that never builds has produced nothing anyone is about to trust; one
     * that builds is asking for exactly that trust, on the strength of guards that never ran.
     *
     * ─── Safe to call unconditionally ────────────────────────────────────────────────────────────────
     * Outside a Codex session `check()` is a no-op that returns ok — Claude Code sessions, CI, and a
     * human at a terminal all pass straight through, which is why this needs no flag and no config key
     * to sit on the shared path. The cures come from the verdict as `Option`s; this method contributes
     * the throw and nothing else, so the two halves cannot drift into two different stories.
     */
    private assertGuardsRan(repoRoot: string): void {
        const verdict: GuardPresenceVerdict = this.guardPresence.check(repoRoot);
        if (verdict.ok) return;
        throw new RuleFailError(
            CODEX_GUARDS_NEVER_RAN, verdict.reason, undefined, undefined, [...verdict.cures]);
    }

    /**
     * The failure text: this gate's own headline, then the pointer at the log the build already wrote.
     *
     * There is no second, streamed variant any more. Capturing used to be behind an EXPERIMENTAL
     * machine-local opt-in, which meant the refusal an agent read depended on a file almost nobody had —
     * and the un-captured branch's advice was "run the build again yourself", which is the single most
     * expensive thing an agent can be told. Reading a FILE is now the only answer this gate gives.
     */
    private failureText(opts: BuildGateOptions, buildCommand: string, logPath: string): string {
        return `\n❌ ${opts.failureHeadline}\n` +
            this.buildLog.failureMessage(buildCommand, logPath) +
            `Fix what that log shows, then re-run ${opts.rerunCommand}.\n`;
    }
}
