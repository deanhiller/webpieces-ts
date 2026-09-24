import { describe, it, expect } from 'vitest';
import { ChecklistInstructionsService } from './checklist-instructions';
import { ChecklistReviewContext, RequiredChecklist, ReviewJsonService } from './review-json';
import { ReviewerAgentPolicy } from './checklist-config';

const inst = new ChecklistInstructionsService(new ReviewJsonService());
const CTX = new ChecklistReviewContext('abc1234', '', 'git diff abc1234 -- <file>');
const REVIEW = '/repo/.webpieces/pr-review/feat/summary.json';

// `n` owed checklists c0..c(n-1), all reviewed by the one shared agent type under cap `max`.
function owed(max: number, n: number): RequiredChecklist[] {
    return Array.from({ length: n }, (_: unknown, i: number): RequiredChecklist =>
        new RequiredChecklist(`c${i}`, new ReviewerAgentPolicy('webpieces-reviewer', max), `.claude/review/c${i}.md`, ['x'], ['**']));
}

describe('ChecklistInstructionsService.names', () => {
    it('gives the checklist ids on one line for a fail-fast headline — not the shared agent type', () => {
        expect(inst.names(owed(1, 2))).toBe('c0, c1');
    });
});

/**
 * `commands.pr-gate.reviewerAgents` (issue #938): a REQUIRED cap on the subagents for the round, with the
 * grouping decision handed to the main AI.
 */
describe('ChecklistInstructionsService — reviewerAgents grouping', () => {
    it('with reviewerAgents = 0: explicitly forbids reviewer subagents and verdict files', () => {
        const text = inst.render(owed(0, 2), REVIEW, CTX);
        expect(text).toContain('reviewerAgents = 0');
        expect(text).toContain('Do not spawn reviewer subagents');
        expect(text).not.toContain('must write:');
    });

    // `reviewerAgents` is required, so there is no un-capped mode left to render. A cap at or above the
    // checklist count still states the cap — it never reverts to the deleted "a SEPARATE subagent for each"
    // prose, which is what a surviving fallback branch would have looked like from here.
    it('a cap equal to the checklist count still speaks in caps, never the deleted SEPARATE wording', () => {
        const text = inst.render(owed(3, 3), REVIEW, CTX);
        expect(text).toContain('using AT MOST 3 `webpieces-reviewer` subagent(s)');
        expect(text).toContain('reviewerAgents = 3');
        expect(text).not.toContain('a SEPARATE `webpieces-reviewer` subagent for each');
    });

    it('with reviewerAgents = 1: at most one subagent, which covers every checklist', () => {
        const text = inst.render(owed(1, 4), REVIEW, CTX);
        expect(text).toContain('using AT MOST 1 `webpieces-reviewer` subagent(s)');
        expect(text).toContain('Use ONE subagent for all of them.');
        expect(text).toContain('it submits ONE verdict');
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
