import { spawnSync } from 'child_process';
import { loadAndValidate, CliExitError, HomeConfigService } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { BuildGateLog } from './build-gate-log';

// Single source of truth for the build gate. Only `wp-finish-upsert-pr` runs it (authoritatively,
// before the one push) — `wp-start-upsert-pr` deliberately runs NO build gate, so `pr-gate.buildCommand`
// is a finish-only knob. nx `affected` only rebuilds changed projects.
// `--base=$(git merge-base origin/main HEAD)` (the fork point) instead of `--base=origin/main`:
// origin/main rebuilds projects touched by OTHER people's merged PRs. The fork point scopes affected to
// only YOUR branch's changes. The `$(...)` resolves because runBuildAffected runs with shell: true.
export const DEFAULT_BUILD_COMMAND = 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)';

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
    // WHICH stage's gate this is — REVIEW_STAGE or FINISH_STAGE. Required, with no default: it is part of
    // the captured log's filename, and a default would silently make two stages share one log file.
    stage: string;

    constructor(label: string, rerunCommand: string, failureHeadline: string, stage: string) {
        this.label = label;
        this.rerunCommand = rerunCommand;
        this.failureHeadline = failureHeadline;
        this.stage = stage;
    }
}

/** Runs the authoritative nx-affected build gate for wp-review-upsert-pr and wp-finish-upsert-pr. */
@injectable(bindingScopeValues.Singleton)
export class BuildAffected {
    constructor(
        private readonly homeConfig: HomeConfigService,
        private readonly buildLog: BuildGateLog,
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
     * Run the build gate. Returns the process exit code (0 = pass).
     *
     * Prints NOTHING itself — `runBuildGate` announces the command in one line. This used to print its own
     * `▶ Build gate: <cmd>` banner on top of that, so the command appeared twice in a row.
     */
    runBuildAffected(repoRoot: string, buildCommand?: string): number {
        const cmd = buildCommand !== undefined && buildCommand.trim() !== '' ? buildCommand : DEFAULT_BUILD_COMMAND;
        const result = spawnSync(cmd, { stdio: 'inherit', cwd: repoRoot, shell: true });
        return result.status ?? 1;
    }

    /** Run the build gate using the project's configured command (PrGateConfig.buildCommand). */
    runConfiguredBuildGate(repoRoot: string): number {
        return this.runBuildAffected(repoRoot, loadAndValidate(repoRoot).prGate.buildCommand);
    }

    /**
     * Run the configured build gate with consistent framing, throwing CliExitError(buildCode) on
     * failure so the bin's main()/runMain owns the exit. Single source of truth: wp-start-upsert-pr and
     * wp-finish-upsert-pr both call THIS (only the BuildGateOptions differ).
     */
    runBuildGate(repoRoot: string, opts: BuildGateOptions): void {
        const buildCommand = this.resolveBuildCommand(repoRoot);
        // TWO lines on the happy path — the command, then the result. The old framing spent a banner and a
        // paragraph explaining how to reproduce a build that was about to pass anyway; that explanation is
        // only useful when the build FAILS, so it now lives solely on the failure path below.
        process.stdout.write(`\n${opts.label}: ${buildCommand}\n`);
        // '' means NOT capturing, which is the case for every user who has not created the OPTIONAL
        // `~/.webpieces/config.json`. Everything below then runs exactly the code it ran before this
        // feature existed — same spawn, same message, no extra file, no extra line of output.
        const logPath = this.isCaptureEnabled() ? this.buildLog.pathFor(repoRoot, opts.stage) : '';
        const buildCode = logPath === ''
            ? this.runConfiguredBuildGate(repoRoot)
            : this.buildLog.run(repoRoot, buildCommand, logPath);
        if (buildCode !== 0) throw new CliExitError(buildCode, this.failureText(opts, buildCommand, logPath));
        process.stdout.write('\n✅ Build passed.\n');
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
