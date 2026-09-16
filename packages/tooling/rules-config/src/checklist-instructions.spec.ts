import { describe, it, expect } from 'vitest';
import { ChecklistInstructionsService } from './checklist-instructions';
import { ChecklistReviewContext, RequiredChecklist, ReviewJsonService } from './review-json';
import { REVIEWER_AGENTS_ONE_PER_CHECKLIST, ReviewerAgentPolicy } from './checklist-config';

const inst = new ChecklistInstructionsService(new ReviewJsonService());
const CTX = new ChecklistReviewContext('abc1234', '', 'git diff abc1234 -- <file>');
const REVIEW = '/repo/.webpieces/pr-review/feat/review.json';

// `n` owed checklists c0..c(n-1), all reviewed by the one shared agent type under cap `max`.
function owed(max: number, n: number): RequiredChecklist[] {
    return Array.from({ length: n }, (_: unknown, i: number): RequiredChecklist =>
        new RequiredChecklist(`c${i}`, new ReviewerAgentPolicy('webpieces-reviewer', max), `.claude/review/c${i}.md`, ['x'], ['**']));
}

describe('ChecklistInstructionsService.names', () => {
    it('gives the checklist ids on one line for a fail-fast headline — not the shared agent type', () => {
        expect(inst.names(owed(REVIEWER_AGENTS_ONE_PER_CHECKLIST, 2))).toBe('c0, c1');
    });
});

/**
 * `commands.pr-gate.reviewerAgents` (issue #938): absent keeps one subagent per checklist; present caps the
 * subagents for the round and hands the grouping decision to the main AI.
 */
describe('ChecklistInstructionsService — reviewerAgents grouping', () => {
    it('without reviewerAgents: a SEPARATE subagent per checklist, no grouping talk', () => {
        const text = inst.render(owed(REVIEWER_AGENTS_ONE_PER_CHECKLIST, 3), REVIEW, CTX);
        expect(text).toContain('You MUST run these 3 checklist review(s) — a SEPARATE `webpieces-reviewer` subagent for each.');
        expect(text).not.toContain('AT MOST');
        expect(text).not.toContain('reviewerAgents');
    });

    it('with reviewerAgents = 1: at most one subagent, which covers every checklist', () => {
        const text = inst.render(owed(1, 4), REVIEW, CTX);
        expect(text).toContain('using AT MOST 1 `webpieces-reviewer` subagent(s)');
        expect(text).toContain('Use ONE subagent for all of them.');
        expect(text).toContain('it writes ONE verdict');
        for (let i = 0; i < 4; i += 1) expect(text).toContain(`review-c${i}.json`);
        expect(text).not.toContain('SEPARATE');
    });

    it('with reviewerAgents = 2 over 8 checklists: suggests an even split', () => {
        const text = inst.render(owed(2, 8), REVIEW, CTX);
        expect(text).toContain('AT MOST 2');
        expect(text).toContain('Group the checklists across them as you judge best');
        expect(text).toContain('2 with about 4 each');
    });

    it('caps at the number of checklists actually owed (a re-run lists only the failed ones)', () => {
        const text = inst.render(owed(5, 2), REVIEW, CTX);
        expect(text).toContain('these 2 checklist review(s) using AT MOST 2');
        expect(text).toContain('(commands.pr-gate.reviewerAgents = 5)');
    });
});
