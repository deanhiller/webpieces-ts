import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';
import {
    HOME_CONFIG_DIR, HOME_CONFIG_FILE, HOME_KEY_TURN_OFF_ALL_REVIEWERS, summaryJsonSchemaHint,
    ChecklistInstructionsService, RequiredChecklist, REVIEWER_AGENTS_PLACEHOLDER, ReviewerAgentPolicy,
    ReviewerBriefing, ReviewerInstructionsService, VERDICT_RED,
} from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';
import { STANDING_REJECTED, STANDING_STALE, VerdictStanding } from './verdict-provenance';
import { ROUND_ACTION_FINISH, ROUND_ACTION_FIX, ROUND_ACTION_RECORD } from './review-round-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * One reviewer that ALREADY ANSWERED on this branch and refused, with the refusal rendered by
 * `ReviewJsonService.refusalError` — the ONE wording, shared with `wp-finish-upsert-pr`. Data-only.
 *
 * Stage ② carries these because it had the same defect finish did: a refused checklist has no passing
 * verdict, so it is "owed", so it got an ordinary spawn block identical to a reviewer that never ran. An
 * agent obeys that block, the reviewer re-reads unchanged code, refuses again — the loop, one stage earlier.
 *
 * The message is rendered by the COMMAND rather than in here for one reason: stage ② must not archive
 * anything. `refusalError` called with no archive path says "fix it, then re-run", which is only true while
 * the verdict file is still live — and at stage ② it is. Retiring a verdict is finish's act, on the refusal
 * it is actually acting on. (The ship-anyway route it prints — the command that writes `override-<id>.json`
 * — is correct at either stage: that is a different file, with its own writer, and no archive touches it.)
 */
export class RefusedReviewer {
    checklistId: string;
    message: string;

    constructor(checklistId: string, message: string) {
        this.checklistId = checklistId;
        this.message = message;
    }
}

/**
 * Everything the closing block of `wp-review-upsert-pr` needs. Data-only, and a class rather than an
 * object literal per CLAUDE.md. The three identifying paths are constructor args; the rest are optional
 * facts about the scan that default to "nothing", so a repo with no checklists constructs it in one line.
 */
export class ReviewReportInput {
    repoRoot: string;
    featureName: string;
    summaryPath: string;             // the branch's summary.json — the file the AI must write next
    definedCount: number;           // how many checklists pr-gate.checklists defines
    applicableCount: number;        // how many of them apply to THIS diff (0 ⇒ the notice, not spawn blocks)
    reviewed: RequiredChecklist[];  // already have a passing verdict on this branch
    formatErrors: string[];         // verdict files that exist but cannot be read as verdicts
    briefings: ReviewerBriefing[];  // one per applicable checklist, already written to disk
    refused: RefusedReviewer[];     // of the owed ones, those that already ran and said no (see RefusedReviewer)
    /**
     * `--no-optional` was passed: the human has already said to submit without the optional reviews, so the
     * block that offers them is replaced by a one-line statement that they were skipped. It never suppresses
     * a REQUIRED reviewer, and it is not a gate — nothing about what blocks the PR changes.
     */
    skipOptional: boolean;
    /**
     * `experimental.turnOffAllReviewers` is TRUE in `~/.webpieces/config.json`, so NO reviewer ran and
     * none will — the REQUIRED ones included. Nothing else in this class may be read as evidence of that:
     * `applicableCount` is 0 under suppression exactly as it is on a docs-only PR that matched nothing,
     * and those two must never print the same thing.
     *
     * When true this stage prints a LOUD banner naming the flag, the file and every suppressed checklist,
     * and prints NO spawn block. Reviewers cannot be spawned — there are no briefings and no instructions
     * files — so a block telling an agent to spawn them would be an instruction it cannot obey.
     */
    reviewersSuppressed: boolean;
    /**
     * The checklists that WOULD have applied, had they not been suppressed. Empty unless
     * `reviewersSuppressed`. Named, not counted, because the one thing a human must be able to see is
     * WHICH required reviewer was killed.
     */
    suppressed: RequiredChecklist[];
    round: number;
    maxReviewerRounds: number;
    roundAction: string;
    redChecklistIds: string[];
    // The reviewer agent (webpieces-reviewer, or the overrideReviewerAgent name) + reviewerAgents: which agent
    // type to spawn, and the per-round cap.
    reviewer: ReviewerAgentPolicy;
    /**
     * How every existing verdict stands (issue #863) — straight off the scan. A CURRENT one is printed as
     * CARRIED with its sha and the reason; a STALE or REJECTED one is printed with why it was re-briefed.
     */
    standings: VerdictStanding[];

    constructor(repoRoot: string, featureName: string, summaryPath: string) {
        this.repoRoot = repoRoot;
        this.featureName = featureName;
        this.summaryPath = summaryPath;
        this.definedCount = 0;
        this.applicableCount = 0;
        this.reviewed = [];
        this.formatErrors = [];
        this.briefings = [];
        this.refused = [];
        this.skipOptional = false;
        this.reviewersSuppressed = false;
        this.suppressed = [];
        this.round = 1;
        this.maxReviewerRounds = 1;
        this.roundAction = '';
        this.redChecklistIds = [];
        this.reviewer = new ReviewerAgentPolicy('', REVIEWER_AGENTS_PLACEHOLDER);
        this.standings = [];
    }
}

/**
 * Renders the closing block of `wp-review-upsert-pr` — the checklist verdict, then EXACTLY ONE "what to do
 * next".
 *
 * Extracted from the command so it can be asserted on as a rendered string, because the ordering IS the
 * contract. The bug it was extracted to fix: the zero-checklist notice ended with "Carry on and run: pnpm
 * wp-finish-upsert-pr", and the block printed directly beneath it said to write summary.json first and
 * finish afterwards. Two next-steps, in the wrong order, and an agent that follows instructions literally —
 * which is the entire reason this command prints them — took the first one and opened a PR with no review.
 * That is precisely the failure the three-stage flow exists to prevent (reported on PR #519).
 *
 * The invariants, enforced by review-report.spec.ts:
 *   1. `wp-finish-upsert-pr` is named as a thing to run EXACTLY ONCE in the whole block.
 *   2. The summary.json instruction comes BEFORE it — and BEFORE the spawn blocks (see nextSteps).
 *   3. With zero checklists the all-clear precedes any configuration guidance.
 *   4. REQUIRED reviewers are spawned unasked; OPTIONAL ones are only ever OFFERED, in one batched
 *      question. The two never share a step, because one instruction says "do it" and the other says
 *      "ask first", and an agent reading a merged list will act on the stronger of the two.
 *
 * Pure string building, no I/O. `@injectable(bindingScopeValues.Singleton)` so it is injected by type.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewReport {
    constructor(
        private readonly checklistNotice: ChecklistNotice,
        private readonly reviewerInstructions: ReviewerInstructionsService,
        private readonly checklistInstructions: ChecklistInstructionsService,
    ) {}

    render(input: ReviewReportInput): string {
        return '\n' + SEP + this.header(input) + SEP
            + this.scanVerdict(input)
            + this.nextSteps(input);
    }

    /**
     * Name what this block is actually about. A repo with reviewers owed is being told to SPAWN; a repo with
     * none is not, and promising subagents it does not have is the same kind of noise as explaining checklist
     * configuration to a repo that configured none. Keyed on what is actually ACTIONABLE rather than on the
     * applicable count: every applicable checklist already having a verdict means nothing to spawn, and so
     * does a branch whose only outstanding reviews are optional ones the human already waved off.
     *
     * "spawn" and "ask about" are separate headings because they are separate obligations. A branch owing
     * only optional reviews has nothing the AI may do unilaterally, and a heading that says SPAWN is the
     * single line most likely to make it do exactly that.
     */
    private header(input: ReviewReportInput): string {
        if (input.roundAction === ROUND_ACTION_FIX) return `② ⛔ GLOBAL REVIEW ROUND ${input.round} OF ${input.maxReviewerRounds} IS RED — remediate it\n`;
        if (input.roundAction === ROUND_ACTION_RECORD) return `② ⛔ GLOBAL REVIEW ROUND ${input.round} OF ${input.maxReviewerRounds} — record the committed remediation\n`;
        if (input.roundAction === ROUND_ACTION_FINISH) return `② ✅ GLOBAL REVIEW ROUND ${input.round} OF ${input.maxReviewerRounds} COMPLETE — finish\n`;
        // FIRST, and unconditional: with the kill switch on there is nothing to spawn and nothing to
        // offer, so every heading below would be true-but-misleading. The one thing a reader must take
        // from the first line of this block is that no reviewer looked at this branch.
        if (input.reviewersSuppressed) return '② ⚫ ALL REVIEWERS SUPPRESSED — write the PR summary, then finish\n';
        if (this.requiredOwed(input).length > 0) return `② GLOBAL REVIEW ROUND ${input.round} OF ${input.maxReviewerRounds} — write the PR summary, spawn reviewers, then finish\n`;
        if (this.offerableOwed(input).length > 0) return '② Write the PR summary, offer the optional reviewers, then finish\n';
        return '② Write the PR summary, then finish\n';
    }

    /**
     * What the SCAN found: either "nothing applies here" or the already-reviewed / unreadable-verdict lines.
     * Verdicts, not instructions — every instruction lives in nextSteps() below, so no line up here can be
     * mistaken for the next action.
     */
    private scanVerdict(input: ReviewReportInput): string {
        // BEFORE the zero-applicable notice, which would otherwise say "nothing matched this diff" — the
        // single most misleading sentence available here, because plenty matched and every one of them was
        // switched off.
        if (input.reviewersSuppressed) return '\n' + this.suppressionBanner(input);
        if (input.applicableCount === 0) return '\n' + this.checklistNotice.build(input.definedCount);
        const lines: string[] = [];
        // The prohibition rides on the REUSE line itself, not only in the all-clear below, because the
        // all-clear is not printed when anything is still owed — and "some reviewers are reused, others
        // must be spawned" is exactly the shape in which an agent re-spawns the reused ones too.
        for (const r of input.reviewed) lines.push(this.carriedLine(input, r));
        lines.push(...this.rebriefedLines(input));
        // A verdict file that EXISTS but is unreadable as a verdict is called out here. Without it this
        // reports the checklist as simply owed, and the AI re-runs a reviewer that already ran instead of
        // correcting the file sitting right there.
        for (const e of input.formatErrors) lines.push(`  ⛔ ${e}`);
        lines.push(...this.skippedLines(input));
        if (this.actionableOwed(input).length === 0) lines.push('', this.allClear(input));
        if (lines.length === 0) return '';
        return '\n' + lines.join('\n') + '\n';
    }

    /**
     * One reused verdict, with WHY it is reused. "Already reviewed" alone was a state, not a reason, and
     * an agent that cannot see why a verdict still counts re-checks it. The sha and the in-scope claim are
     * the reason: that verdict judged exactly the diff its checklist is judged on now.
     */
    private carriedLine(input: ReviewReportInput, r: RequiredChecklist): string {
        const standing = input.standings.find((s: VerdictStanding): boolean => s.checklistId === r.id);
        if (standing === undefined) {
            return `  ✓ ${r.id} — already reviewed on this branch; verdict STANDS, do NOT re-spawn (review-${r.id}.json)`;
        }
        return `  ✓ ${r.id} — carried ${standing.status.toUpperCase()} from ${this.short(standing.fromSha)}, `
            + `in-scope files unchanged; verdict STANDS, do NOT re-spawn`;
    }

    /**
     * The verdicts that exist on disk but do NOT count, each with why — so a reviewer listed below is not
     * mistaken for one that simply never ran. A STALE red is not listed here: it is still a refusal, and
     * its block below says so.
     */
    private rebriefedLines(input: ReviewReportInput): string[] {
        const lines: string[] = [];
        for (const s of input.standings) {
            if (s.standing === STANDING_STALE && s.status !== VERDICT_RED) {
                lines.push(`  ↻ ${s.checklistId} — ${s.status.toUpperCase()} from ${this.short(s.fromSha)} is STALE: ${s.reason}; re-briefed below`);
            }
            if (s.standing === STANDING_REJECTED) {
                lines.push(`  ⛔ ${s.checklistId} — verdict REJECTED: ${s.reason}; re-briefed below`);
            }
        }
        return lines;
    }

    private short(sha: string): string {
        return sha === '' ? '(unknown sha)' : sha.slice(0, 8);
    }

    /**
     * THE LOUD BANNER. The one output in this whole flow that says an unreviewed PR is about to be posted.
     *
     * Everything in it is there because a reader has to be able to act on it or audit it: the FLAG name and
     * the FILE it was read from (the only actionable thing — nothing in any repo turns this off), the COUNT
     * split by required/optional, and every suppressed checklist BY NAME with REQUIRED marked. A count
     * alone would leave "which required reviewer did I just skip?" unanswerable at the one moment it is
     * being answered.
     *
     * It deliberately does NOT name `wp-finish-upsert-pr` — the closing step already does, exactly once,
     * and that "exactly once" is an invariant this class's docstring records having been bought with a bug.
     */
    private suppressionBanner(input: ReviewReportInput): string {
        const required = input.suppressed.filter((r: RequiredChecklist): boolean => r.required);
        const projectDisabled = input.reviewer.maxAgents === 0;
        const lines: string[] = [
            projectDisabled
                ? '⚫ ALL REVIEWER SUBAGENTS ARE DISABLED FOR THIS PROJECT. Nothing reviewed this branch.'
                : '⚫ ALL REVIEWER SUBAGENTS ARE SWITCHED OFF ON THIS MACHINE. Nothing reviewed this branch.',
            '',
            `   ${input.suppressed.length} checklist(s) matched this diff and were SUPPRESSED — `
            + `${required.length} of them REQUIRED:`,
        ];
        for (const r of input.suppressed) {
            lines.push(`     • ${r.id}${r.required ? '  (REQUIRED — suppressed anyway)' : '  (optional)'}`);
        }
        lines.push(
            '',
            ...(projectDisabled ? [
                '   Switched off by:  commands.pr-gate.reviewerAgents: 0',
                '   Read from:        webpieces.config.json  (project policy; build and PR gates remain active)',
            ] : [
                `   Switched off by:  experimental.${HOME_KEY_TURN_OFF_ALL_REVIEWERS}: true`,
                `   Read from:        ~/${HOME_CONFIG_DIR}/${HOME_CONFIG_FILE}  (machine-local; no repo config can set this)`,
            ]),
            '',
            '   There is NOTHING to spawn — no reviewer was briefed and no instructions file was written,',
            '   so any attempt to spawn one has nothing to read. Do NOT hand-write a verdict file in their',
            '   place: a fabricated verdict is worse than the absent one this flag deliberately produces.',
            '',
            '   The dashboard is the whole review product for this PR, and the suppression is carried into',
            '   the PR body — which is the squash-merge commit body — so main\'s history records it.',
            projectDisabled
                ? '   To get reviewers back, set reviewerAgents to a positive integer and re-run this command.'
                : '   To get the reviewers back, set that key to false (or delete it) and re-run this command.',
        );
        return lines.join('\n') + '\n';
    }

    /**
     * `--no-optional`, stated as a VERDICT rather than left silent. Named individually, not just counted: the
     * whole reason the human is allowed to skip these is that they know this diff, and the only way they can
     * catch "wait, not THAT one" is to see which ones went unreviewed.
     */
    private skippedLines(input: ReviewReportInput): string[] {
        const skipped = this.optionalOwed(input);
        if (!input.skipOptional || skipped.length === 0) return [];
        return [
            '',
            `  ⏭️  ${skipped.length} OPTIONAL checklist(s) matched this diff and were SKIPPED (--no-optional):`,
            ...skipped.map((b: ReviewerBriefing): string => `       ${b.checklistId} — ${this.why(b)}`),
            '      Not blocking. Drop the flag and re-run this command to offer them after all.',
        ];
    }

    /**
     * The all-clear, then the RULE that makes it actionable.
     *
     * "nothing to spawn" on its own is a description of the current state, and an agent that has just been
     * told a state — rather than a rule — treats re-spawning as a judgement call it is entitled to make. It
     * then makes it, reasoning (correctly, on the facts) that the carried-forward verdicts judged an earlier
     * tree. Reviews here are once per branch BY CONSTRUCTION: a passing review-<id>.json satisfies its
     * checklist for the branch's whole life, and `wp-finish-upsert-pr` never archives one the way it archives
     * summary.json. So the reuse is deliberate — it is what keeps post-PR iteration from re-paying for every
     * matched reviewer — and the output has to say so, because the alternative reading is the expensive one.
     *
     * The overwrite warning is not decoration. A re-spawned reviewer writes to the SAME verdict path, so a
     * gratuitous re-run does not merely cost a subagent — it destroys the verdict that was already banked.
     *
     * It must NOT claim everything was reviewed when optional reviews were skipped — that is the one sentence
     * that would turn a deliberate skip into a false record of a review that happened.
     */
    private allClear(input: ReviewReportInput): string {
        const headline = input.skipOptional && this.optionalOwed(input).length > 0
            ? '✅ Nothing left to spawn — every REQUIRED checklist is reviewed (optional ones skipped above).'
            : '✅ Every checklist that applies is already reviewed — nothing to spawn.';
        return headline + '\n' + this.oncePerBranchRule();
    }

    /**
     * The once-per-branch rule, stated as a prohibition rather than left to be inferred from a ✅.
     *
     * Printed whenever verdicts are being reused — which is every iteration of a PR after the first, i.e. the
     * majority of stage-② runs on any branch that gets review feedback.
     */
    private oncePerBranchRule(): string {
        return (
            '   A passing verdict CARRIES FORWARD for as long as its checklist\'s in-scope files are unchanged,\n' +
            '   deliberately, so edits elsewhere cost no reviewer tokens. When those files DO change, this\n' +
            '   stage re-briefs that checklist itself and names it in a STEP below. Do NOT re-spawn a reviewer\n' +
            '   listed above to "re-check" — it burns a full subagent run AND replaces the verdict it already\n' +
            '   submitted. The only reviewers you may spawn are ones a STEP below names.'
        );
    }

    /**
     * The ONE instruction block, and the last thing the stage prints. Numbered rather than prose-linked
     * ("Then… Finally…") so that skipping step 1 is visibly skipping a step, and worded so no earlier line
     * can be mistaken for the real next action.
     *
     * summary.json is STEP 1 and the spawn blocks are STEP 2 — that ORDER is the contract, not a preference.
     * This block used to print the spawn blocks first and then say to write summary.json "WHILE any reviewer
     * subagents above are still running", which does not merely permit spawning first, it instructs it.
     * Harmless for a reviewer that only reads the diff; wrong for one that judges the PR's stated INTENT —
     * its title, summary or risk level — because summary.json is the only place that intent lives. Such a
     * reviewer either finds no file (a false RED and a wasted reviewer run) or, on a second run of this
     * stage on the same branch, finds the PREVIOUS run's file and validates a title that no longer exists —
     * a false GREEN, with nothing in the output saying which of the two happened. A consuming repo had to
     * write itself a rule telling its agents to DISOBEY this block to work around it.
     *
     * What the old ordering bought was overlap on a single local file write, not a subagent round-trip.
     *
     * The schema hint is rendered by ReviewJsonService — the single renderer — so the shape printed here
     * can never drift from the shape `wp-finish-upsert-pr` validates.
     */
    private nextSteps(input: ReviewReportInput): string {
        if (input.roundAction === ROUND_ACTION_FIX) return this.fixStep(input);
        if (input.roundAction === ROUND_ACTION_RECORD) return this.recordStep(input);
        if (input.roundAction === ROUND_ACTION_FINISH) return this.cappedFinishStep(input);
        const required = this.requiredOwed(input);
        const offerable = this.offerableOwed(input);
        // Numbered by what is actually PRINTED, so the numbers a reader sees are 1..n with no gaps: write
        // summary.json, then a spawn step only if anything must run, then an offer step only if anything may.
        let step = 1;
        const write = this.writeSummaryStep(input.summaryPath, step++, '');
        // The wait block goes under the LAST reviewer-listing step, and only there. Printed under both
        // it would be two "what to do next" instructions in one output, which is the defect this
        // method's docstring describes — an agent reading top to bottom obeys the first one it meets.
        const spawn = required.length === 0 ? '' : this.spawnStep(input, required, step++, offerable.length === 0);
        const offer = offerable.length === 0 ? '' : this.offerStep(input, offerable, step++, true);
        return '\n' + SEP
            + `▶ NEXT — ${step} steps, in this order. Step 1 is NOT optional:\n` + SEP + '\n'
            + write + spawn + offer + this.finishStep(step, required.length + offerable.length > 0);
    }

    private writeSummaryStep(summaryPath: string, step: number, mainAgentInstructions: string): string {
        return (
            `STEP ${step} — write the PR summary (title, summary, risk) to summary.json. Write it FIRST — BEFORE you spawn\n` +
            '         anything below. finish REFUSES without it, and a reviewer subagent may READ it: a\n' +
            '         checklist that judges the PR title, summary or risk level reads exactly this file, so\n' +
            '         writing it afterwards races that reviewer into seeing nothing — or, on a re-run of this\n' +
            '         stage, into judging the PREVIOUS run\'s summary of code that has since changed.\n\n' +
            summaryJsonSchemaHint(summaryPath, mainAgentInstructions) + '\n\n'
        );
    }

    private fixStep(input: ReviewReportInput): string {
        return '\n' + SEP + `▶ NEXT — fix every finding from round ${input.round} of ${input.maxReviewerRounds}\n` + SEP + '\n'
            + `   Red checklist(s): ${input.redChecklistIds.join(', ')}\n`
            + '   Commit every fix and leave the tree clean, then record one response per checklist with:\n'
            + '         pnpm wp-write-review-fixes\n'
            + '   Re-run pnpm wp-review-upsert-pr after that. It will start a focused remediation-only round\n'
            + '   only when the configured round budget still has room.\n';
    }

    private recordStep(input: ReviewReportInput): string {
        return '\n' + SEP + `▶ NEXT — record the committed fixes for round ${input.round} of ${input.maxReviewerRounds}\n` + SEP + '\n'
            + '         pnpm wp-write-review-fixes\n\n'
            + '   The command stamps the reviewed HEAD and current clean HEAD itself. Then re-run\n'
            + '   pnpm wp-review-upsert-pr; do not edit or recolor the reviewer verdict.\n';
    }

    private cappedFinishStep(input: ReviewReportInput): string {
        const capped = input.redChecklistIds.length > 0
            ? `   Review cap reached. ${input.redChecklistIds.join(', ')} is author-remediated after the cap and was NOT re-reviewed.\n`
            : '';
        return '\n' + SEP + '▶ NEXT — write summary.json, then finish\n' + SEP + '\n'
            + capped + this.writeSummaryStep(input.summaryPath, 1, '')
            + 'STEP 2 — run: pnpm wp-finish-upsert-pr\n';
    }

    /**
     * The REQUIRED reviewers — one copy-paste block each, and nothing at all when none is owed. The prompt is
     * deliberately a POINTER and nothing else: the generated instructions file is the contract, so anything
     * restated here is a second copy that can go stale — which is exactly how a removed `success` field
     * outlived its own removal in print.
     *
     * These are spawned WITHOUT asking. They are the checklists the repo declared `required: true`, which is
     * the repo saying the decision was already made; putting them to the human again would re-open a question
     * the config exists to settle.
     */
    private spawnStep(input: ReviewReportInput, owed: readonly ReviewerBriefing[], step: number, withAwait: boolean): string {
        const lines: string[] = [
            `STEP ${step} — only once that file is written, review these ${owed.length} REQUIRED checklist(s) with`,
            ...this.howManyAgents(input, owed.length),
            '         They block the PR, so do NOT ask whether to run them. You may NOT review your own',
            '         work, and you may NOT submit a reviewer\'s verdict on its behalf: pnpm wp-write-review',
            '         refuses the coordinating agent, and finish rejects a verdict file written by hand.',
            '',
        ];
        lines.push(...this.refusedWarning(input, owed));
        for (const b of owed) lines.push(...this.oneSpawnBlock(input, b));
        if (withAwait) lines.push(...this.awaitLines());
        lines.push('');
        return lines.join('\n');
    }

    /**
     * How to WAIT once the spawn list has been spawned — printed after the blocks, because it is the
     * next thing to do and nothing before it can be mistaken for it.
     *
     * It is here because the alternative is measured and expensive: `echo .` every three seconds at
     * ~557,000 tokens a turn, 18.3% of every token the fleet spent in the 24h to 2026-09-07 (#874).
     *
     * It names the efficient options and the wasteful one, and then stops (#902). It does NOT prescribe
     * ending the turn: waiting on the subagents you just spawned is something an agent already does
     * routinely, and whether to do that here is a judgement this string cannot make for it.
     *
     * It names no other stage. `finishStep` below is the ONE place this whole block names
     * `wp-finish-upsert-pr`, and a second mention here would be a second "what to do next" instruction
     * for an agent reading top to bottom — the exact defect the class docstring above describes.
     */
    private awaitLines(): string[] {
        return [
            '         Then WAIT. Be efficient with tokens: wait on the subagents you just spawned, or block',
            '         in one call with the command below. Do NOT send status checks every few seconds, and',
            '         do NOT run `echo` to keep your turn alive — a turn costs your whole context, ~557k',
            '         tokens.',
            '',
            '             pnpm wp-await-reviews',
            '',
            '         It heartbeats while it waits, returns as soon as the last verdict lands, and prints',
            '         what each reviewer said. If the wait is long it exits asking to be run again.',
        ];
    }

    /**
     * STEP n — the OPTIONAL reviewers: listed, never spawned unasked.
     *
     * This is the whole point of `required: false`. A one-line bug fix in a repo whose checklists key on a
     * glob as broad as every TypeScript file otherwise pays for a dozen subagent reviews, and the only party
     * who can judge whether this particular diff is worth them is the human looking at it.
     *
     * ONE batched multi-select question, explicitly. Asked one at a time, a human answering "no" nine times
     * is being worn down rather than consulted, and by the third question the cheap thing is to say yes to
     * everything — which is the state this feature exists to leave. The "None" option has to be spelled out
     * too: an agent that offers a list without an explicit way to decline it has not really offered a choice.
     *
     * The blocking consequence is stated because it is the one non-obvious part of the contract: `required`
     * governs whether a reviewer must RUN, not whether its answer counts. Choosing to run one and then
     * shrugging off a red verdict would make the whole exercise theater.
     */
    private offerStep(input: ReviewReportInput, offerable: readonly ReviewerBriefing[], step: number, withAwait: boolean): string {
        const lines: string[] = [
            `STEP ${step} — these ${offerable.length} OPTIONAL review checklist(s) matched this diff. They do NOT block the`,
            '         PR, and you may NOT decide for the human whether to run them.',
            '',
            '         ASK THE HUMAN, in ONE multi-select question listing all of them plus an explicit',
            '         "None — required only" choice. Do not ask one question per reviewer. Then spawn ONLY',
            '         what they picked, the same way as any other reviewer.',
            '',
            '         If they pick none, that is a complete answer: go straight to the final step. If they',
            '         told you up front to submit without reviews, re-run this stage as',
            '         `pnpm wp-review-upsert-pr --no-optional` and this step disappears.',
            '',
            '         NOTE: whichever ones you DO run, their verdicts count in full — a red verdict from an',
            '         optional reviewer blocks the PR exactly like a required one.',
            '',
        ];
        lines.push(...this.optionalAgentLines(input, offerable.length));
        lines.push(...this.refusedWarning(input, offerable));
        for (const b of offerable) lines.push(...this.oneSpawnBlock(input, b));
        if (withAwait) lines.push(...this.awaitLines());
        lines.push('');
        return lines.join('\n');
    }

    // How the picked optional checklists are staffed. Grouped, the cap covers the WHOLE round, required
    // reviewers included — otherwise "at most N" would quietly become 2N the moment a human said yes.
    private optionalAgentLines(input: ReviewReportInput, count: number): string[] {
        const reviewer = input.reviewer;
        const required = this.requiredOwed(input).length;
        // The Codex pointer is printed once per report: by the required step when there is one.
        const codex = required > 0 ? [] : [this.agentDefinitionLine(input)];
        const scope = required > 0 ? `, COUNTING the ${required} required checklist(s) above — fold picked ones into those subagents` : '';
        return [
            `         Review what they picked with \`${reviewer.agentName}\` subagents: at most ${reviewer.maxAgents} IN TOTAL`,
            `         this round${scope}. Hand each subagent the instructions file of every checklist it covers.`,
            ...codex,
            ...(count > 0 ? [''] : []),
        ];
    }

    // Said up front, not only beside the block: an agent that has decided to spawn everything listed here
    // needs to know BEFORE it starts that one of these entries is not a spawn-shaped task. Scoped to the
    // group being printed — a refusal among the REQUIRED reviewers is not a caveat on the optional list.
    private refusedWarning(input: ReviewReportInput, group: readonly ReviewerBriefing[]): string[] {
        const ids = new Set(group.map((b: ReviewerBriefing): string => b.checklistId));
        const n = input.refused.filter((r: RefusedReviewer): boolean => ids.has(r.checklistId)).length;
        if (n === 0) return [];
        return [
            `         ${n} of them already ANSWERED and refused (marked ⛔ below). Do not spawn`,
            '         those against unchanged code — fix what they found first; the fix is the prerequisite.',
            '',
        ];
    }

    private finishStep(stepNumber: number, anyReviewers: boolean): string {
        // "every reviewer you ran" rather than "every reviewer above": with an optional list the human may
        // legitimately have run none of them, and a precondition naming reviewers that were declined reads as
        // an unmeetable one.
        const precondition = anyReviewers
            ? 'once every reviewer you ran has submitted its verdict'
            : 'once that file exists';
        return (
            `STEP ${stepNumber} — only ${precondition}, run:  pnpm wp-finish-upsert-pr\n` +
            '         (The build gate is already green for this commit — finish reuses it unless HEAD moves.)\n\n'
        );
    }

    // The briefings with no passing verdict yet — the ONE definition of "owed", shared by the header, the
    // scan verdict and the step numbering, so they cannot disagree about whether there is anything to spawn.
    private owedReviewers(input: ReviewReportInput): ReviewerBriefing[] {
        const reviewedIds = new Set(input.reviewed.map((r: RequiredChecklist): string => r.id));
        return input.briefings.filter((b: ReviewerBriefing): boolean => !reviewedIds.has(b.checklistId));
    }

    // Owed AND blocking — spawned without asking.
    private requiredOwed(input: ReviewReportInput): ReviewerBriefing[] {
        return this.owedReviewers(input).filter((b: ReviewerBriefing): boolean => b.required);
    }

    // Owed and optional. Still listed under `--no-optional` (as a skip verdict), just never as a step.
    private optionalOwed(input: ReviewReportInput): ReviewerBriefing[] {
        return this.owedReviewers(input).filter((b: ReviewerBriefing): boolean => !b.required);
    }

    // The optional ones the human is actually to be ASKED about — none, once they have already answered.
    private offerableOwed(input: ReviewReportInput): ReviewerBriefing[] {
        return input.skipOptional ? [] : this.optionalOwed(input);
    }

    // Everything the AI still has to act on. Distinct from `owedReviewers`: a skipped optional checklist is
    // owed a verdict it will never get, and treating it as pending work is what would print a spawn
    // instruction for a review the human just declined.
    private actionableOwed(input: ReviewReportInput): ReviewerBriefing[] {
        return [...this.requiredOwed(input), ...this.offerableOwed(input)];
    }

    /**
     * One reviewer's block. A reviewer that already REFUSED gets the SAME spawn coordinates but a different
     * lead-in, because the action before spawning is different: its own words are printed, and the spawn is
     * explicitly conditioned on having fixed the finding first.
     *
     * It keeps its spawn block rather than being dropped from the list, because the reviewer genuinely does
     * still owe a fresh verdict — dropping it would leave nothing anywhere saying how to get one. What must
     * not happen is a bare "spawn this" that reads identically to a reviewer that never ran, which is the
     * loop this exists to break.
     */
    private oneSpawnBlock(input: ReviewReportInput, b: ReviewerBriefing): string[] {
        const instructionsFile = this.reviewerInstructions.pathFor(input.repoRoot, input.featureName, b.checklistId);
        // The subagent_type is stated once, above; each block is one checklist's file to hand to
        // whichever subagent covers it.
        return [...this.leadIn(input, b), `      instructions:  ${instructionsFile}`, ''];
    }

    /**
     * HOW MANY subagents, of WHICH type — the one place this report states it, shared by the required and
     * the optional step so the two cannot disagree.
     *
     * Positive `commands.pr-gate.reviewerAgents` values give the main AI a CAP and the
     * grouping decision: the point of the key is to stop paying for N agents re-reading the same diff, and
     * the AI is the one that can see which checklists belong together. The cap is per ROUND, so a re-run
     * after a red verdict re-reviews only the owed checklists — the only ones listed — under the same cap.
     */
    private howManyAgents(input: ReviewReportInput, count: number): string[] {
        const reviewer = input.reviewer;
        const cap = Math.min(reviewer.maxAgents, count);
        return [
            `         AT MOST ${cap} subagent(s) of type \`${reviewer.agentName}\` (commands.pr-gate.reviewerAgents = ${reviewer.maxAgents}).`,
            `         ${this.checklistInstructions.groupingHint(count, cap)}`,
            '         Spawn each one as:',
            `             subagent_type: ${reviewer.agentName}`,
            '             prompt:        Read EACH instructions file below FIRST and follow it exactly. Review each',
            '                            checklist only over its own in-scope files and submit ONE verdict per',
            '                            checklist with pnpm wp-write-review — never one for a checklist you were',
            '                            not given.',
            '                            <then list the instructions file of every checklist this subagent covers>',
            '         Every checklist below must be covered by exactly one of those subagents.',
            this.agentDefinitionLine(input),
        ];
    }

    /**
     * The ONE canonical reviewer definition, named for a harness that cannot spawn it by type. Codex has no
     * registered agent types, so its subagent is generic; pointing it at the same committed file keeps one
     * definition for both harnesses instead of a Codex-specific copy that drifts (#863).
     */
    private agentDefinitionLine(input: ReviewReportInput): string {
        const file = path.join(input.repoRoot, '.claude', 'agents', `${input.reviewer.agentName}.md`);
        return `         Codex (no agent types): spawn a generic subagent with NO forked turns (fresh context — do not\n`
            + `         fork this conversation into it) and hand it ONLY the instructions files below; it reads\n`
            + `         ${file} first. The brief on disk is its whole input: a forked conversation hands a\n`
            + `         reviewer the author's reasoning, which costs tokens and its independence.`;
    }

    // The lines above the spawn coordinates: normally just why this reviewer is in scope; for one that
    // already refused, its verdict verbatim plus the order the two actions must happen in.
    private leadIn(input: ReviewReportInput, b: ReviewerBriefing): string[] {
        const refusal = input.refused.find((r: RefusedReviewer): boolean => r.checklistId === b.checklistId);
        if (!refusal) return [`  ▶ ${b.checklistId} — ${this.why(b)}`, ...this.docLine(b)];
        return [
            `  ⛔ ${b.checklistId} — ALREADY REVIEWED THIS BRANCH AND REFUSED. It will refuse again on unchanged code.`,
            `      ${refusal.message}`,
            '      FIX THE FINDING FIRST (or record a human-authored override). ONLY THEN spawn it again, to',
            '      write a fresh verdict:',
        ];
    }

    /**
     * The checklist's guidance doc, for OPTIONAL reviewers only.
     *
     * "4 file(s) matched" plus a broad glob does not tell a human what the review would actually look AT,
     * and they are being asked to decide exactly that. Omitted for required reviewers: there is no decision
     * to inform there — the reviewer runs either way, and the doc is already in its instructions file.
     */
    private docLine(b: ReviewerBriefing): string[] {
        if (b.required || b.docPath === '') return [];
        return [`      reviews against: ${b.docPath}`];
    }

    // Why this one is in scope. A patternless checklist is NOT "matched" — it always runs, over the whole
    // diff, and saying so is what tells a repo its checklist is firing on docs-only PRs by design.
    private why(b: ReviewerBriefing): string {
        if (b.matchedPatterns.length === 0) {
            return `ALWAYS RUNS (no "patterns" configured), whole diff in scope — ${b.myFiles.length} file(s)`;
        }
        return `${b.myFiles.length} file(s) matched ${b.matchedPatterns.map((p: string): string => `"${p}"`).join(', ')}`;
    }
}
