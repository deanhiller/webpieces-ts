import { spawnSync } from 'child_process';
import { CliExitError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { AwaitLoop, WaitOutcome, WaitProbe } from '../workflow/await-loop';
import { StageOutputLog } from '../workflow/stage-output-log';

/** What `wp-await-checks` was asked to wait on. Data-only (a class, per CLAUDE.md). */
export class AwaitChecksOptions {
    /** The PR number, exactly as `--pr` gave it. REQUIRED — there is no "guess which PR" branch. */
    prNumber: string;

    // REQUIRED, no default. A defaulted "current branch's PR" would be a second spelling of the one
    // question this command asks, reachable by typing less, and the failure mode is watching the wrong
    // PR go green.
    constructor(prNumber: string) {
        this.prNumber = prNumber;
    }
}

/**
 * `wp-await-checks --pr <n>` — BLOCK until GitHub's checks for that PR stop being in flight, then print
 * where they landed.
 *
 * ─── OFFERED, NEVER INSTRUCTED ─────────────────────────────────────────────────────────────────────
 * This exists for the see-it-land case, and for nothing else. `wp-finish-upsert-pr` still ends with
 * "Nothing else is owed by the tooling — a person merges it. You can stop here.", and that stays the
 * DEFAULT: several of this repo's workflows deliberately stop at a green PR, and landing is the
 * developer's call, not the tooling's. Nothing here or in the finish banner tells an agent to wait —
 * the banner names this command as an option and says out loud that stopping is still correct.
 *
 * What it replaces is the `echo .` keep-alive an agent falls back to when it has decided to see the PR
 * land. See {@link AwaitLoop} for when a blocking command is the right wait at all — this is offered as
 * the efficient alternative to polling, and nothing here rules on turn-level behaviour (issue #902).
 *
 * ─── `gh pr checks <n> --watch` EXISTS, AND WHEN TO REACH FOR EACH ─────────────────────────────────
 * It is a real blocking wait, not a spin, and `wait-spin-guard` never denies it — 224 subagent and 84
 * main-agent uses in the measured window. So this command does not pretend it is absent, and it is not
 * a replacement for it. The difference is one property and it decides the choice:
 *
 *   `gh pr checks <n> --watch`  has NO BOUNDED EXIT. On a CI run longer than the harness's 600s
 *                               silence ceiling it is KILLED having printed nothing, and the wait is
 *                               simply lost. Right for a short, known-fast run you are watching.
 *   `pnpm wp-await-checks`      heartbeats throughout and RETURNS CLEANLY at 540s saying "run me
 *                               again", so a 100-minute wait costs ~11 calls instead of a killed
 *                               command and a restart. Right for any wait that might outlast the
 *                               ceiling, which is any wait you cannot bound in advance.
 *
 * ─── It reports, it does not judge ─────────────────────────────────────────────────────────────────
 * A red check is an ANSWER, so the wait ends and the state is printed. Deciding what a failure means is
 * the caller's, and turning a red check into a non-zero exit here would make "the checks finished" and
 * "the checks passed" the same signal — which is exactly how a red PR gets reported as landed.
 */
@injectable(bindingScopeValues.Singleton)
export class AwaitChecksCommand {
    constructor(
        private readonly awaitLoop: AwaitLoop,
        private readonly stageConsole: StageOutputLog,
    ) {}

    async run(opts: AwaitChecksOptions): Promise<void> {
        const probe = new ChecksWaitProbe(opts.prNumber);
        const outcome = await this.awaitLoop.run(probe);
        this.stageConsole.say(outcome.done ? probe.settledReport(outcome) : probe.stillWaitingReport(outcome));
    }
}

/** One check run's rollup state, as GitHub reports it. Data-only. */
export class ChecksState {
    /** How many checks GitHub currently lists. 0 means it has not created any yet — QUEUED, not absent. */
    total: number;
    pending: number;
    failed: number;
    /** True when `gh` could not be asked at all — the wait keeps going rather than claiming an answer. */
    unreadable: boolean;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(total: number, pending: number, failed: number, unreadable: boolean) {
        this.total = total;
        this.pending = pending;
        this.failed = failed;
        this.unreadable = unreadable;
    }

    /**
     * Settled means GitHub has created checks AND none of them is still running.
     *
     * `total === 0` is deliberately NOT settled. An empty rollup seconds after a push means the workflow
     * has not been created yet — QUEUED — and treating it as "no checks, all clear" is how a PR gets
     * called green before CI has started. The wait's own ceiling is what ends that case, and it ends it
     * by saying "still waiting", which is the truth.
     */
    get settled(): boolean {
        return !this.unreadable && this.total > 0 && this.pending === 0;
    }

    describe(): string {
        if (this.unreadable) return 'gh could not be read';
        if (this.total === 0) return 'no checks reported yet (queued)';
        return `${String(this.total - this.pending)} of ${String(this.total)} done, `
            + `${String(this.failed)} failed`;
    }
}

/**
 * The CI wait: one `gh pr view` per poll, classified into {@link ChecksState}.
 *
 * `gh pr view --json statusCheckRollup` rather than `gh pr checks`, because the rollup field is the
 * stable JSON surface and returns an EMPTY array — not an error exit — for a PR whose checks have not
 * been created yet. `gh pr checks` exits non-zero in several distinct "nothing to report" situations,
 * which would make "queued" and "gh is broken" the same observation.
 */
export class ChecksWaitProbe implements WaitProbe {
    readonly label = 'CI checks';
    // A network round trip per poll, so this is deliberately slow. CI on this repo runs ~1 minute; a
    // 15-second poll finds it within a heartbeat of finishing and costs ~36 API calls per full wait.
    readonly pollMs = 15_000;

    private state: ChecksState = new ChecksState(0, 0, 0, true);

    constructor(private readonly prNumber: string) {}

    done(): boolean {
        this.state = this.read();
        return this.state.settled;
    }

    describe(): string {
        return this.state.describe();
    }

    settledReport(outcome: WaitOutcome): string {
        const verdict = this.state.failed === 0
            ? `🟢 All ${String(this.state.total)} check(s) passed`
            : `🔴 ${String(this.state.failed)} of ${String(this.state.total)} check(s) FAILED`;
        return `\n${verdict} after ${String(outcome.waitedSeconds)}s.\n`
            + `   Read the detail with:  gh pr checks ${this.prNumber}\n`;
    }

    stillWaitingReport(outcome: WaitOutcome): string {
        return `\n⏳ Checks are still in flight after ${String(outcome.waitedSeconds)}s (${this.state.describe()})`
            + ` — run me again:  pnpm wp-await-checks --pr ${this.prNumber}\n`
            + '   (This is not a failure. The wait returns before the harness kills a quiet command.)\n';
    }

    /**
     * One read of the rollup. Fails to `unreadable` rather than to "settled": a `gh` that cannot answer
     * must never be able to end the wait, because the only thing worse than waiting too long is
     * announcing an outcome nobody observed.
     */
    private read(): ChecksState {
        const result = spawnSync(
            'gh',
            ['pr', 'view', this.prNumber, '--json', 'statusCheckRollup',
                '--jq', '[.statusCheckRollup[] | (.status // .state)] | @tsv'],
            { encoding: 'utf8' });
        if (result.status !== 0) return new ChecksState(0, 0, 0, true);
        return this.classify((result.stdout ?? '').trim());
    }

    // `status` is COMPLETED / IN_PROGRESS / QUEUED for a check run; a plain commit status has no
    // `status` and its `state` is SUCCESS / PENDING / FAILURE / ERROR. The jq above collapses the two
    // into one token per check, and everything that is not finished counts as pending.
    private classify(tsv: string): ChecksState {
        const tokens = tsv === '' ? [] : tsv.split(/\s+/);
        const pending = tokens.filter((t: string): boolean => PENDING_TOKENS.has(t)).length;
        const failed = tokens.filter((t: string): boolean => FAILED_TOKENS.has(t)).length;
        return new ChecksState(tokens.length, pending, failed, false);
    }
}

const PENDING_TOKENS: ReadonlySet<string> = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);
const FAILED_TOKENS: ReadonlySet<string> = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * `--pr` is required, and this is where that is enforced — before the loop starts, so a caller that
 * forgot it is told immediately rather than after a nine-minute wait on nothing.
 */
export class AwaitChecksArgs {
    /** The PR number from argv, or a CliExitError naming the flag it needs. */
    parse(value: string): AwaitChecksOptions {
        if (!/^\d+$/.test(value.trim())) {
            throw new CliExitError(2,
                '❌ wp-await-checks needs the PR number to wait on:  pnpm wp-await-checks --pr <n>\n'
                + '   `gh pr view --json number` prints it for the current branch.');
        }
        return new AwaitChecksOptions(value.trim());
    }
}
