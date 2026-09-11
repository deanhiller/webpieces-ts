import { describe, it, expect } from 'vitest';
import { ReviewerBriefing, ReviewerInstructionsService, ReviewJsonService } from '@webpieces/rules-config';
import { ChecklistNotice } from './checklist-notice';
import { ReviewReport, ReviewReportInput } from './review-report';
import { FinishBanner, FinishBannerInput } from './finish-banner';
import {
    MergeOutcome, MERGE_RESULT_MERGED, MERGE_RESULT_AUTO_QUEUED, MERGE_RESULT_LEFT_TO_HUMAN,
    MERGE_RESULT_BEHIND_CLEAN, MERGE_RESULT_BEHIND_CONFLICTING, MERGE_RESULT_BEHIND_UNKNOWN,
    MERGE_RESULT_FAILED,
} from './pr-merger';

/**
 * ══ webpieces NEVER TELLS AN AI TO END ITS TURN (issue #902) ═══════════════════════════════════════
 *
 * The principle is `.claude/rules/never-tell-an-ai-to-end-its-turn.md`. This file is the half of its
 * enforcement that covers what the GATE prints; `ai-hook-rules`' spec of the same name covers what the
 * guards refuse with.
 *
 * An agent already knows how to wait — it waits on subagents it spawned, routinely, without being told.
 * A fixed rule baked into a printed string is substituting for a judgement it cannot see. What webpieces
 * legitimately controls is the stupid poll, and `wait-spin-guard` still blocks that.
 *
 * It asserts over the strings the gate ACTUALLY RENDERS, every stage and every outcome — not over the
 * source text, because a grep of the source is satisfied the moment somebody moves the sentence into a
 * constant or builds it from two halves.
 *
 * THE ONE PERMITTED SPELLING is the NEGATIVE one: `Do NOT end your turn with "want me to open a PR?"`
 * in `webpieces.git-workflow.md` is the OPPOSITE instruction and is the finish-the-feature contract.
 * So the check strips the negated form first and only then forbids what is left.
 */
const NEGATED = /\b(?:do not|do NOT|don't|never)\s+end (?:your|the|its) turn/gi;
const PRESCRIBES_ENDING = /\bend(?:ing|s)? (?:your|the|its) turn\b/i;

const offends = (text: string): boolean => PRESCRIBES_ENDING.test(text.replace(NEGATED, ''));

const banner = new FinishBanner();
const input = (outcome: MergeOutcome): FinishBannerInput =>
    new FinishBannerInput('902', 'https://github.com/o/r/pull/902', 'My PR title', 'dean/feature', outcome);

const OUTCOMES = new Map<string, MergeOutcome>([
    ['merged', new MergeOutcome(true, false, 'squash-merged', MERGE_RESULT_MERGED)],
    ['auto-queued', new MergeOutcome(false, true, 'enabled auto-merge', MERGE_RESULT_AUTO_QUEUED)],
    ['left-to-human', new MergeOutcome(false, false, 'did NOT merge — mergeMode is NONE', MERGE_RESULT_LEFT_TO_HUMAN)],
    ['behind-clean', new MergeOutcome(false, true, 'did NOT merge — BEHIND', MERGE_RESULT_BEHIND_CLEAN)],
    ['behind-conflicting', new MergeOutcome(false, true, 'did NOT merge — BEHIND', MERGE_RESULT_BEHIND_CONFLICTING)],
    ['behind-unknown', new MergeOutcome(false, true, 'did NOT merge — BEHIND', MERGE_RESULT_BEHIND_UNKNOWN)],
    ['failed', new MergeOutcome(false, false, 'did NOT merge and could NOT auto-merge', MERGE_RESULT_FAILED)],
]);

const report = new ReviewReport(new ChecklistNotice(), new ReviewerInstructionsService(new ReviewJsonService()));

const reviewInput = (definedCount: number, applicableCount: number, briefings: ReviewerBriefing[]): ReviewReportInput => {
    const built = new ReviewReportInput('/repo', 'dean-feature', '/repo/.webpieces/pr-review/dean-feature/review.json');
    built.definedCount = definedCount;
    built.applicableCount = applicableCount;
    built.briefings = briefings;
    return built;
};

const owedReviewer = (): ReviewerBriefing => {
    const briefing = new ReviewerBriefing('db-migration-reviewer', 'db-migration-reviewer', '/repo');
    briefing.matchedPatterns = ['**/*.sql'];
    return briefing;
};

/** Every user-facing block these two stages can print, keyed by the situation that produces it. */
const emitted = (): Map<string, string> => {
    const rendered = new Map<string, string>();
    for (const [name, outcome] of OUTCOMES) {
        rendered.set(`finish-banner: ${name}`, banner.render(input(outcome)));
        rendered.set(`finish-banner link directive: ${name}`, banner.linkDirective(input(outcome)));
    }
    rendered.set('review-report: no checklists', report.render(reviewInput(0, 0, [])));
    rendered.set('review-report: nothing matched', report.render(reviewInput(3, 0, [])));
    rendered.set('review-report: one owed reviewer', report.render(reviewInput(1, 1, [owedReviewer()])));
    return rendered;
};

describe('no string the gate prints tells an AI to end its turn', () => {
    it('renders something for every case, so an empty map cannot pass this file', () => {
        const rendered = emitted();
        expect(rendered.size).toBe(OUTCOMES.size * 2 + 3);
        expect([...rendered.values()].filter((text: string): boolean => text.length > 0).length)
            .toBeGreaterThan(OUTCOMES.size);
    });

    it('never prescribes ending the turn, in any stage or outcome', () => {
        for (const [where, text] of emitted()) {
            expect(offends(text), `${where} tells the agent to end its turn`).toBe(false);
        }
    });

    /**
     * The detector has to be able to FAIL, or the assertion above is decoration. These pin both
     * directions: the prescription is caught, and the "do NOT stop before posting the PR" sentence the
     * finish-the-feature contract depends on is spared.
     */
    it('catches the prescription and spares the negation', () => {
        expect(offends('Cheapest: END YOUR TURN — anything still pending re-invokes you for free.')).toBe(true);
        expect(offends('It names ENDING THE TURN first.')).toBe(true);
        expect(offends('Do NOT end your turn with "want me to open a PR?"')).toBe(false);
        expect(offends('Be efficient with tokens: pnpm wp-await-checks --pr <n> blocks in one call.')).toBe(false);
    });

    /**
     * The replacement is not merely the absence of the old sentence: the watch offer still has to NAME
     * the efficient wait and the wasteful one, or deleting the advice would have deleted the guidance.
     */
    it('still names the efficient wait and refuses the wasteful one', () => {
        const text = banner.render(input(OUTCOMES.get('auto-queued') as MergeOutcome));
        expect(text).toContain('Be efficient with tokens');
        expect(text).toContain('pnpm wp-await-checks --pr <n>');
        expect(text).toContain('Do not send status checks every few seconds');
        expect(text).toContain('never `echo` to keep a turn alive');
    });
});
