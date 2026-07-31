import { injectable, bindingScopeValues } from 'inversify';
import { reviewJsonSchemaHint, RequiredChecklist, ReviewerBriefing, ReviewerInstructionsService } from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

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

    constructor(repoRoot: string, featureName: string, reviewPath: string) {
        this.repoRoot = repoRoot;
        this.featureName = featureName;
        this.reviewPath = reviewPath;
        this.definedCount = 0;
        this.applicableCount = 0;
        this.reviewed = [];
        this.formatErrors = [];
        this.briefings = [];
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
 *   2. The review.json instruction comes BEFORE it.
 *   3. With zero checklists the all-clear precedes any configuration guidance.
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
        return '\n' + SEP + this.header(input) + SEP + '\n'
            + this.checklistSection(input)
            + this.nextSteps(input.reviewPath);
    }

    // Name what this block is actually about. A repo with reviewers owed is being told to SPAWN; a repo
    // with none is not, and promising subagents it does not have is the same kind of noise as explaining
    // checklist configuration to a repo that configured none.
    private header(input: ReviewReportInput): string {
        if (input.applicableCount === 0) return '② Review, then finish\n';
        return '② Spawn Subagent Reviews, then finish\n';
    }

    // Either "nothing applies here" or the copy-paste spawn blocks — never both, and neither one ends with
    // a command to run: the single next step lives in nextSteps() below.
    private checklistSection(input: ReviewReportInput): string {
        if (input.applicableCount === 0) return this.checklistNotice.build(input.definedCount);
        return this.spawnBlocks(input);
    }

    /**
     * The ONE instruction block, and the last thing the stage prints. Numbered rather than prose-linked
     * ("Then… Finally…") so that skipping step 1 is visibly skipping a step, and worded so no earlier line
     * can be mistaken for the real next action.
     *
     * The schema hint is rendered by ReviewJsonService — the single renderer — so the shape printed here
     * can never drift from the shape `wp-finish-upsert-pr` validates.
     */
    private nextSteps(reviewPath: string): string {
        return (
            '\n' + SEP +
            '▶ NEXT — two steps, in this order. Step 1 is NOT optional:\n' + SEP + '\n' +
            'STEP 1 — review your own changes, then write the review file (finish REFUSES without it).\n' +
            '         Do this WHILE any reviewer subagents above are still running:\n\n' +
            reviewJsonSchemaHint(reviewPath) + '\n\n' +
            'STEP 2 — only once that file exists, run:  pnpm wp-finish-upsert-pr\n' +
            '         (The build gate is already green for this commit — finish reuses it unless HEAD moves.)\n\n'
        );
    }

    /**
     * One copy-paste block per owed reviewer. The prompt is deliberately a POINTER and nothing else: the
     * generated instructions file is the contract, so anything restated here is a second copy that can go
     * stale — which is exactly how a removed `success` field outlived its own removal in print.
     */
    private spawnBlocks(input: ReviewReportInput): string {
        const reviewedIds = new Set(input.reviewed.map((r: RequiredChecklist): string => r.id));
        const owed = input.briefings.filter((b: ReviewerBriefing): boolean => !reviewedIds.has(b.checklistId));
        const lines: string[] = [];
        for (const r of input.reviewed) {
            lines.push(`  ✓ ${r.subagent} — already reviewed on this branch (reusing its review-${r.id}.json)`);
        }
        // A verdict file that EXISTS but is unreadable as a verdict is called out here. Without it this
        // reports the checklist as simply owed, and the AI re-runs a reviewer that already ran instead of
        // correcting the file sitting right there.
        for (const e of input.formatErrors) lines.push(`  ⛔ ${e}`);
        if (owed.length === 0) {
            lines.push('', '✅ Every checklist that applies is already reviewed — nothing to spawn.');
            return lines.join('\n') + '\n';
        }
        lines.push('',
            `Spawn these ${owed.length} reviewer subagent(s) — a SEPARATE one each. You may NOT review your own`,
            'work, and you may NOT write a reviewer\'s verdict file on its behalf.',
            '');
        for (const b of owed) lines.push(...this.oneSpawnBlock(input, b));
        return lines.join('\n');
    }

    private oneSpawnBlock(input: ReviewReportInput, b: ReviewerBriefing): string[] {
        return [
            `  ▶ ${b.subagent} — ${this.why(b)}`,
            `      subagent_type: ${b.subagent}`,
            '      prompt:        Read your instructions file FIRST and follow it exactly:',
            `                     ${this.reviewerInstructions.pathFor(input.repoRoot, input.featureName, b.subagent)}`,
            '',
        ];
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
