import {
    ChecklistResult, ChecklistVerdict, CK_FAIL, CK_MISSING, CK_BAD_FORMAT, loadAndValidate,
    RepoRootFinder, RequiredChecklist, ReviewJsonService,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

import { AwaitLoop, WaitOutcome, WaitProbe } from '../workflow/await-loop';
import { ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { StageOutputLog } from '../workflow/stage-output-log';

/**
 * `wp-await-reviews` — BLOCK until every reviewer stage ② requested for this branch has written its
 * verdict, then print what each one said.
 *
 * ─── Why a command and not an instruction ──────────────────────────────────────────────────────────
 * An agent that has just spawned four reviewer subagents has nothing to do until they answer, and a
 * worktree-isolated subagent cannot simply wait: ending its turn ends its run. See {@link AwaitLoop}
 * for the full chain and the measurement (18.3% of all fleet tokens in one day spent on `echo .`).
 * A blocking Bash call is the only wait primitive it has, so webpieces provides one.
 *
 * ─── It INVENTS NO STATE ───────────────────────────────────────────────────────────────────────────
 * The set of reviewers a branch owes is `ChecklistScanner`'s answer — the SAME one `wp-review-upsert-pr`
 * lists and `wp-finish-upsert-pr` blocks on — and the verdicts are the `review-<id>.json` files those
 * two already read. Nothing here writes anything, and there is no third opinion about who is owed: a
 * waiter that computed its own set could finish while finish still refused, which is the one outcome
 * that would make waiting worse than not waiting.
 *
 * The scan runs ONCE. Its `applicable` set is a function of the diff, which does not change while the
 * agent sits still, so re-scanning per poll would re-run `git diff` every few seconds to re-derive an
 * unchanged answer. Only the verdict FILES are re-read, which is the only thing a reviewer changes.
 *
 * ─── What it does NOT do ───────────────────────────────────────────────────────────────────────────
 * It does not judge. A red verdict is a completed review, so this command RETURNS on it and prints it;
 * refusing the PR over it is `wp-finish-upsert-pr`'s job and stays there. It exits non-zero only when it
 * cannot do its own job at all.
 */
@injectable(bindingScopeValues.Singleton)
export class AwaitReviewsCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly checklistScanner: ChecklistScanner,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly awaitLoop: AwaitLoop,
        private readonly stageConsole: StageOutputLog,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const config = loadAndValidate(repoRoot).prGate;
        // contextStage '' — a WAIT must not write pr-context.json. That file records the diff a review
        // was briefed against, and rewriting it mid-review would restate the briefing under the
        // reviewers currently reading it.
        const scan = this.checklistScanner.scan(repoRoot, config.checklists, new ChecklistScanOptions(true, ''));
        if (scan.reviewersDisabled) return this.reportDisabled(scan.suppressed);
        if (scan.applicable.length === 0) return this.reportNothingOwed();
        // WAIT on the set finish blocks on (`outstanding`), REPORT on everything that applies. The two
        // sets differ by exactly the optional checklists nobody ran — `required: false` means the PR does
        // not wait for them, and a wait that did would never end, because nothing is ever going to write
        // a verdict for a reviewer that was deliberately never spawned. (The SET is shared with finish;
        // the PREDICATE is not — see `done()` for why a wait ends on arrival and finish does not.)
        const probe = new ReviewerWaitProbe(
            this.reviewJsonService, scan.reviewPath, scan.outstanding, scan.applicable);
        const outcome = await this.awaitLoop.run(probe);
        this.report(probe, outcome);
    }

    // Nothing to wait for, and saying so is the whole value: an agent that got no answer here would
    // otherwise assume the wait is still owed and start spinning again.
    private reportNothingOwed(): void {
        this.stageConsole.say('\n✅ No reviewer was requested for this branch — nothing to wait for.\n');
    }

    private reportDisabled(suppressed: readonly RequiredChecklist[]): void {
        this.stageConsole.say(
            `\n⚫ Every reviewer is switched off on this machine (experimental.turnOffAllReviewers), so `
            + `${String(suppressed.length)} checklist(s) that would have run are not running. There is `
            + 'nothing to wait for.\n');
    }

    private report(probe: ReviewerWaitProbe, outcome: WaitOutcome): void {
        this.stageConsole.say(outcome.done ? probe.verdictReport(outcome) : probe.stillWaitingReport(outcome));
    }
}

/**
 * The reviewer wait itself: which checklists are owed, and what the files on disk say about them right
 * now. It owns the reporting too, because every line it prints is derived from the same verdict read —
 * a report that re-read the files could disagree with the answer that ended the wait.
 */
export class ReviewerWaitProbe implements WaitProbe {
    readonly label = 'reviewers';
    // Verdict files are local reads, so polling them costs nothing worth economizing on. Fast enough
    // that the command returns within seconds of the last reviewer finishing, which is the point.
    readonly pollMs = 3_000;

    private results: ChecklistResult[] = [];

    constructor(
        private readonly reviewJsonService: ReviewJsonService,
        private readonly reviewPath: string,
        private readonly waitedOn: readonly RequiredChecklist[],
        private readonly applicable: readonly RequiredChecklist[],
    ) {
        this.reload();
    }

    /**
     * Done when every awaited reviewer has ANSWERED — not when every answer is a pass.
     *
     * That distinction is the whole contract of a wait, and getting it wrong makes the command useless
     * in the case it matters most. `ReviewJsonService.pendingChecklists` is finish's GATE predicate and
     * counts a RED verdict as still owed, correctly: the PR is refused until the finding is fixed. But
     * a red reviewer has finished; it will never write a different answer on its own, so waiting for it
     * to stop being red is waiting forever. The wait therefore ends on ARRIVAL — a verdict file that
     * exists, whatever it says — and `wp-finish-upsert-pr` keeps sole ownership of the gate.
     *
     * `CK_BAD_FORMAT` counts as arrived too: the file is there and unreadable, which is a thing to FIX
     * (four characters of JSON), not a thing to wait longer for.
     */
    done(): boolean {
        this.reload();
        return this.pending().length === 0;
    }

    describe(): string {
        const owed = this.pending().length;
        const total = this.waitedOn.length;
        return `${String(total - owed)} of ${String(total)} verdicts in`;
    }

    /** Every reviewer's answer, printed once the wait is over — the reason to wait rather than sleep. */
    verdictReport(outcome: WaitOutcome): string {
        // The headline counts what was WAITED ON; the list below covers everything that APPLIES, so an
        // optional checklist nobody ran shows as ❓ rather than being quietly dropped. Reporting only the
        // waited-on set would let a shorter list imply the others passed.
        const lines = [
            `\n✅ All ${String(this.waitedOn.length)} awaited reviewer verdict(s) are in after `
            + `${String(outcome.waitedSeconds)}s:\n`,
        ];
        for (const req of this.applicable) lines.push(this.oneVerdict(req));
        lines.push(this.nextStep());
        return lines.join('\n') + '\n';
    }

    /**
     * The timeout report. It is a NORMAL exit and says so, because an agent that reads this as a failure
     * goes hunting for a broken reviewer instead of running one more plain command.
     */
    stillWaitingReport(outcome: WaitOutcome): string {
        const owed = this.pending();
        return `\n⏳ Still waiting after ${String(outcome.waitedSeconds)}s — run me again:  pnpm wp-await-reviews\n`
            + '   (This is not a failure. The wait returns before the harness kills a quiet command, so a\n'
            + '    long review costs a handful of calls instead of hundreds of keep-alive turns.)\n\n'
            + `   ${String(owed.length)} of ${String(this.waitedOn.length)} still owe a verdict: `
            + `${owed.map((r: RequiredChecklist): string => r.id).join(', ')}\n`;
    }

    private oneVerdict(req: RequiredChecklist): string {
        const verdict = this.reviewJsonService.resolveVerdict(req, this.results);
        return `   ${this.icon(verdict)} ${verdict.id} — ${verdict.status}${this.detail(verdict)}`;
    }

    // Only a NON-passing verdict's detail is printed. A green reviewer's output is already on the PR,
    // and reprinting four of them here would bury the one line that needs acting on.
    private detail(verdict: ChecklistVerdict): string {
        if (verdict.status !== CK_FAIL || verdict.detail === '') return '';
        return `\n      ${verdict.detail.split('\n').join('\n      ')}`;
    }

    private icon(verdict: ChecklistVerdict): string {
        if (verdict.status === CK_FAIL) return '🔴';
        if (verdict.status === CK_MISSING || verdict.status === CK_BAD_FORMAT) return '❓';
        return '🟢';
    }

    // Named because a wait that ends without saying what it unblocked leaves the agent to guess, and
    // guessing here means spinning again. A red verdict changes the next move, so it is called out.
    private nextStep(): string {
        const anyRed = this.applicable.some((req: RequiredChecklist): boolean =>
            this.reviewJsonService.resolveVerdict(req, this.results).status === CK_FAIL);
        return anyRed
            ? '\n   A reviewer REFUSED. Fix what it found — re-spawning it against unchanged code buys the\n'
                + '   same answer — then re-run the review stage.\n'
            : '\n   Nothing is owed on the review front.\n';
    }

    // The awaited checklists whose verdict file has not appeared yet — see `done()` for why this is
    // arrival and not the gate's own "still owed".
    private pending(): RequiredChecklist[] {
        return this.waitedOn.filter((req: RequiredChecklist): boolean =>
            this.reviewJsonService.resolveVerdict(req, this.results).status === CK_MISSING);
    }

    private reload(): void {
        this.results = this.reviewJsonService.loadChecklistResults(this.reviewPath, this.applicable);
    }
}
