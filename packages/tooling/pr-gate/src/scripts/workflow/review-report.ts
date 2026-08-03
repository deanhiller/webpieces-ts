import { injectable, bindingScopeValues } from 'inversify';
import { reviewJsonSchemaHint, RequiredChecklist, ReviewerBriefing, ReviewerInstructionsService } from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';

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
 * anything. `refusalError` called with no archive path says "fix it, then re-run; or set an override in
 * review-<id>.json", which is only true while that file is still live — and at stage ② it is. Retiring a
 * verdict is finish's act, on the refusal it is actually acting on.
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
    reviewPath: string;             // the branch's review.json — the file the AI must write next
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

    constructor(repoRoot: string, featureName: string, reviewPath: string) {
        this.repoRoot = repoRoot;
        this.featureName = featureName;
        this.reviewPath = reviewPath;
        this.definedCount = 0;
        this.applicableCount = 0;
        this.reviewed = [];
        this.formatErrors = [];
        this.briefings = [];
        this.refused = [];
        this.skipOptional = false;
    }
}

/**
 * Renders the closing block of `wp-review-upsert-pr` — the checklist verdict, then EXACTLY ONE "what to do
 * next".
 *
 * Extracted from the command so it can be asserted on as a rendered string, because the ordering IS the
 * contract. The bug it was extracted to fix: the zero-checklist notice ended with "Carry on and run: pnpm
 * wp-finish-upsert-pr", and the block printed directly beneath it said to write review.json first and
 * finish afterwards. Two next-steps, in the wrong order, and an agent that follows instructions literally —
 * which is the entire reason this command prints them — took the first one and opened a PR with no review.
 * That is precisely the failure the three-stage flow exists to prevent (reported on PR #519).
 *
 * The invariants, enforced by review-report.spec.ts:
 *   1. `wp-finish-upsert-pr` is named as a thing to run EXACTLY ONCE in the whole block.
 *   2. The review.json instruction comes BEFORE it — and BEFORE the spawn blocks (see nextSteps).
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
        if (this.requiredOwed(input).length > 0) return '② Review, spawn subagent reviewers, then finish\n';
        if (this.offerableOwed(input).length > 0) return '② Review, offer the optional reviewers, then finish\n';
        return '② Review, then finish\n';
    }

    /**
     * What the SCAN found: either "nothing applies here" or the already-reviewed / unreadable-verdict lines.
     * Verdicts, not instructions — every instruction lives in nextSteps() below, so no line up here can be
     * mistaken for the next action.
     */
    private scanVerdict(input: ReviewReportInput): string {
        if (input.applicableCount === 0) return '\n' + this.checklistNotice.build(input.definedCount);
        const lines: string[] = [];
        for (const r of input.reviewed) {
            lines.push(`  ✓ ${r.subagent} — already reviewed on this branch (reusing its review-${r.id}.json)`);
        }
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
            ...skipped.map((b: ReviewerBriefing): string => `       ${b.subagent} — ${this.why(b)}`),
            '      Not blocking. Drop the flag and re-run this command to offer them after all.',
        ];
    }

    // The all-clear. It must NOT claim everything was reviewed when optional reviews were skipped — that is
    // the one sentence that would turn a deliberate skip into a false record of a review that happened.
    private allClear(input: ReviewReportInput): string {
        if (input.skipOptional && this.optionalOwed(input).length > 0) {
            return '✅ Nothing left to spawn — every REQUIRED checklist is reviewed (optional ones skipped above).';
        }
        return '✅ Every checklist that applies is already reviewed — nothing to spawn.';
    }

    /**
     * The ONE instruction block, and the last thing the stage prints. Numbered rather than prose-linked
     * ("Then… Finally…") so that skipping step 1 is visibly skipping a step, and worded so no earlier line
     * can be mistaken for the real next action.
     *
     * review.json is STEP 1 and the spawn blocks are STEP 2 — that ORDER is the contract, not a preference.
     * This block used to print the spawn blocks first and then say to write review.json "WHILE any reviewer
     * subagents above are still running", which does not merely permit spawning first, it instructs it.
     * Harmless for a reviewer that only reads the diff; wrong for one that judges the PR's stated INTENT —
     * its title, summary or risk level — because review.json is the only place that intent lives. Such a
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
        const required = this.requiredOwed(input);
        const offerable = this.offerableOwed(input);
        // Numbered by what is actually PRINTED, so the numbers a reader sees are 1..n with no gaps: write
        // review.json, then a spawn step only if anything must run, then an offer step only if anything may.
        let step = 1;
        const write = this.writeReviewStep(input.reviewPath, step++);
        const spawn = required.length === 0 ? '' : this.spawnStep(input, required, step++);
        const offer = offerable.length === 0 ? '' : this.offerStep(input, offerable, step++);
        return '\n' + SEP
            + `▶ NEXT — ${step} steps, in this order. Step 1 is NOT optional:\n` + SEP + '\n'
            + write + spawn + offer + this.finishStep(step, required.length + offerable.length > 0);
    }

    private writeReviewStep(reviewPath: string, step: number): string {
        return (
            `STEP ${step} — review your own changes, then write the review file. Write it FIRST — BEFORE you spawn\n` +
            '         anything below. finish REFUSES without it, and a reviewer subagent may READ it: a\n' +
            '         checklist that judges the PR title, summary or risk level reads exactly this file, so\n' +
            '         writing it afterwards races that reviewer into seeing nothing — or, on a re-run of this\n' +
            '         stage, into judging the PREVIOUS run\'s review of code that has since changed.\n\n' +
            reviewJsonSchemaHint(reviewPath) + '\n\n'
        );
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
    private spawnStep(input: ReviewReportInput, owed: readonly ReviewerBriefing[], step: number): string {
        const lines: string[] = [
            `STEP ${step} — only once that file is written, spawn these ${owed.length} REQUIRED reviewer subagent(s) — a`,
            '         SEPARATE one each. They block the PR, so do NOT ask whether to run them. You may NOT',
            '         review your own work, and you may NOT write a reviewer\'s verdict file on its behalf.',
            '',
        ];
        lines.push(...this.refusedWarning(input, owed));
        for (const b of owed) lines.push(...this.oneSpawnBlock(input, b));
        lines.push('');
        return lines.join('\n');
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
    private offerStep(input: ReviewReportInput, offerable: readonly ReviewerBriefing[], step: number): string {
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
        lines.push(...this.refusedWarning(input, offerable));
        for (const b of offerable) lines.push(...this.oneSpawnBlock(input, b));
        lines.push('');
        return lines.join('\n');
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
            ? 'once every reviewer you ran has written its verdict file'
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
        const instructionsFile = this.reviewerInstructions.pathFor(input.repoRoot, input.featureName, b.subagent);
        return [
            ...this.leadIn(input, b),
            `      subagent_type: ${b.subagent}`,
            '      prompt:        Read your instructions file FIRST and follow it exactly:',
            `                     ${instructionsFile}`,
            '',
        ];
    }

    // The lines above the spawn coordinates: normally just why this reviewer is in scope; for one that
    // already refused, its verdict verbatim plus the order the two actions must happen in.
    private leadIn(input: ReviewReportInput, b: ReviewerBriefing): string[] {
        const refusal = input.refused.find((r: RefusedReviewer): boolean => r.checklistId === b.checklistId);
        if (!refusal) return [`  ▶ ${b.subagent} — ${this.why(b)}`, ...this.docLine(b)];
        return [
            `  ⛔ ${b.subagent} — ALREADY REVIEWED THIS BRANCH AND REFUSED. It will refuse again on unchanged code.`,
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
