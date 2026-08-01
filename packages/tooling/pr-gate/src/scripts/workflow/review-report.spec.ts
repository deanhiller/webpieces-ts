import { describe, it, expect } from 'vitest';
import { RequiredChecklist, ReviewerBriefing, ReviewerInstructionsService, ReviewJsonService } from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';
import { RefusedReviewer, ReviewReport, ReviewReportInput } from './review-report';

const REVIEW_PATH = '/repo/.webpieces/pr-review/dean-feature/review.json';
const report = new ReviewReport(new ChecklistNotice(), new ReviewerInstructionsService(new ReviewJsonService()));

const inputWith = (definedCount: number, applicableCount: number): ReviewReportInput => {
    const input = new ReviewReportInput('/repo', 'dean-feature', REVIEW_PATH);
    input.definedCount = definedCount;
    input.applicableCount = applicableCount;
    return input;
};

const withOneOwedReviewer = (): ReviewReportInput => {
    const input = inputWith(1, 1);
    const briefing = new ReviewerBriefing('db-migration-reviewer', 'db-migration-reviewer', '/repo');
    briefing.matchedPatterns = ['**/*.sql'];
    input.briefings = [briefing];
    return input;
};

const noChecklists = (): string => report.render(inputWith(0, 0));
const nothingMatched = (): string => report.render(inputWith(3, 0));
const oneOwed = (): string => report.render(withOneOwedReviewer());

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * THE regression. On PR #519 an agent read stage ②'s output top to bottom, hit "Carry on and run: pnpm
 * wp-finish-upsert-pr" in the zero-checklist notice, and ran finish — skipping the review.json instruction
 * printed directly beneath it. These assertions treat the output as an API: exactly one next step, in the
 * order it must actually be performed.
 */
describe('exactly one "what to do next", in the right order', () => {
    const everyVariant = (): string[] => [noChecklists(), nothingMatched(), oneOwed()];

    it('names wp-finish-upsert-pr as something to run EXACTLY once, in every variant', () => {
        for (const text of everyVariant()) {
            expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
        }
    });

    it('puts the review.json instruction BEFORE the finish command, always', () => {
        for (const text of everyVariant()) {
            expect(text.indexOf('Write your PR review to:')).toBeGreaterThanOrEqual(0);
            expect(text.indexOf('Write your PR review to:')).toBeLessThan(text.indexOf('wp-finish-upsert-pr'));
        }
    });

    it('prints the review.json path and the schema the finish gate validates', () => {
        expect(noChecklists()).toContain(REVIEW_PATH);
        expect(noChecklists()).toContain('"riskLevel"');
    });

    // No line may read as "you are done, go finish" before step 1 has been stated.
    it('never says to carry on / continue to a command before review.json is asked for', () => {
        for (const text of everyVariant()) {
            expect(text).not.toMatch(/carry on and run/i);
            const beforeStep1 = text.slice(0, text.indexOf('STEP 1'));
            expect(beforeStep1).not.toContain('wp-finish-upsert-pr');
        }
    });

    it('makes step 1 explicitly non-optional', () => {
        expect(noChecklists()).toContain('Step 1 is NOT optional');
    });
});

/**
 * THE regression this ordering exists for. The block used to print the spawn blocks and THEN say to write
 * review.json "WHILE any reviewer subagents above are still running" — an instruction to spawn first. A
 * reviewer whose checklist judges the PR's stated intent (title / summary / risk level) reads review.json
 * itself, so spawning first means it reads nothing (false RED, wasted run) or, on a second stage-② run on
 * the same branch, the PREVIOUS run's file (false GREEN against a title that no longer exists). Asserted on
 * the rendered string because the ordering IS the contract.
 */
describe('review.json is written BEFORE any reviewer is spawned', () => {
    it('puts the review.json instruction before the first spawn block', () => {
        const text = oneOwed();
        expect(text.indexOf('Write your PR review to:')).toBeLessThan(text.indexOf('subagent_type:'));
    });

    it('numbers writing the review file as step 1 and spawning as step 2', () => {
        const text = oneOwed();
        expect(text.indexOf('STEP 1')).toBeLessThan(text.indexOf('STEP 2'));
        expect(text).toMatch(/STEP 2 — only once that file is written, spawn/);
        expect(text).toContain('STEP 3');
    });

    it('never tells the AI to write the review while the reviewers run', () => {
        for (const text of [noChecklists(), nothingMatched(), oneOwed()]) {
            expect(text).not.toMatch(/WHILE any reviewer subagents/i);
        }
    });

    // Nothing to spawn ⇒ no step 2 to number, so finish must be step 2 rather than a step 3 with a hole.
    it('drops the spawn step entirely when no reviewer is owed', () => {
        const text = nothingMatched();
        expect(text).toContain('▶ NEXT — 2 steps');
        expect(text).not.toContain('STEP 3');
        expect(text).not.toContain('subagent_type:');
    });

    it('counts three steps when a reviewer is owed', () => {
        expect(oneOwed()).toContain('▶ NEXT — 3 steps');
    });
});

describe('a repo with zero checklists gets the verdict first, not a tutorial', () => {
    it('gives the all-clear before any configuration guidance', () => {
        const text = noChecklists();
        expect(text.indexOf('✅')).toBeLessThan(text.indexOf('webpieces.config.json'));
    });

    it('states the verdict within the first handful of lines after the header', () => {
        const lines = noChecklists().split('\n');
        const verdict = lines.findIndex((l: string): boolean => l.includes('NONE CONFIGURED'));
        const allClear = lines.findIndex((l: string): boolean => l.includes('✅'));
        expect(verdict).toBeGreaterThanOrEqual(0);
        expect(allClear).toBe(verdict + 1);
    });

    // Deleting the how-to would be the wrong fix — it is what teaches a repo to get reviews at all.
    it('still keeps the how-to-configure guidance, just below the all-clear', () => {
        const text = noChecklists();
        expect(text).toContain('db-migration-reviewer');
        expect(text).toContain('"patterns"');
    });
});

describe('reviewers still owed', () => {
    it('prints one spawn block naming the subagent and its generated instructions file', () => {
        const text = oneOwed();
        expect(text).toContain('subagent_type: db-migration-reviewer');
        expect(text).toContain('/repo/.webpieces/pr-review/dean-feature/instructions/db-migration-reviewer.instructions.md');
        expect(text).toContain('file(s) matched "**/*.sql"');
    });

    it('reuses an already-reviewed checklist instead of re-spawning it', () => {
        const input = withOneOwedReviewer();
        input.reviewed = [new RequiredChecklist('db-migration-reviewer', 'db-migration-reviewer', '', [])];
        const text = report.render(input);
        expect(text).toContain('already reviewed on this branch');
        expect(text).toContain('nothing to spawn');
        expect(text).not.toContain('subagent_type:');
        // Even here — nothing left to spawn — the ONE next step is still review.json, then finish.
        expect(countOf(text, 'wp-finish-upsert-pr')).toBe(1);
    });

    it('calls out unreadable verdict files so the AI fixes the file instead of re-running a reviewer', () => {
        const input = withOneOwedReviewer();
        input.formatErrors = ['review-db-migration-reviewer.json: missing "status"'];
        expect(report.render(input)).toContain('missing "status"');
    });
});

/**
 * Stage ② had the SAME defect `wp-finish-upsert-pr` did: a refused checklist has no passing verdict, so it
 * is not in `reviewed`, so it was printed as an ordinary owed reviewer with an ordinary spawn block — word
 * for word what a reviewer that never ran gets. An agent obeys that, the reviewer re-reads unchanged code
 * and refuses again, and the loop starts one stage earlier than the loop that was reported.
 *
 * The refusal text itself is NOT re-worded here: it comes from ReviewJsonService.refusalError, the one
 * renderer, so these assertions are about placement and framing, which is what stage ② got wrong.
 */
describe('a reviewer that already REFUSED is not re-instructed as one that never ran', () => {
    const REFUSAL = 'Checklist "db-migration-reviewer" FAILED review (status:"red"). The reviewer wrote:\n      no backfill';

    const withRefusal = (): ReviewReportInput => {
        const input = withOneOwedReviewer();
        input.refused = [new RefusedReviewer('db-migration-reviewer', REFUSAL)];
        return input;
    };

    it("prints the reviewer's own finding instead of only a spawn block", () => {
        const text = report.render(withRefusal());
        expect(text).toContain('no backfill');
        expect(text).toContain('ALREADY REVIEWED THIS BRANCH AND REFUSED');
    });

    it('conditions the re-spawn on fixing the finding FIRST, and says so before the coordinates', () => {
        const text = report.render(withRefusal());
        expect(text.indexOf('FIX THE FINDING FIRST')).toBeLessThan(text.indexOf('subagent_type:'));
    });

    it('warns at the top of the step, before an agent starts spawning everything listed', () => {
        const text = report.render(withRefusal());
        expect(text.indexOf('already ANSWERED and refused')).toBeLessThan(text.indexOf('⛔ db-migration-reviewer'));
    });

    // It still owes a FRESH verdict, so dropping its spawn block would leave nothing saying how to get one.
    it('keeps the spawn coordinates, for after the fix', () => {
        expect(report.render(withRefusal())).toContain('subagent_type: db-migration-reviewer');
    });

    // Stage ② enforces nothing and must therefore destroy nothing: retiring the verdict is finish's act on
    // the refusal it is actually enforcing (asserted here as the absence of any claim that it moved).
    it('never claims the verdict was retired — stage ② archives nothing', () => {
        const text = report.render(withRefusal());
        expect(text).not.toContain('RETIRED');
        expect(text).not.toContain('.json.old');
    });

    it('leaves the ordinary spawn block alone when nothing refused', () => {
        const text = oneOwed();
        expect(text).not.toContain('REFUSED');
        expect(text).toContain('▶ db-migration-reviewer — 0 file(s) matched "**/*.sql"');
    });
});
