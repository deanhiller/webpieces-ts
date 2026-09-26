import { describe, it, expect } from 'vitest';
import { validatePrGateSection } from './validate-config';

// Split out of validate-config.spec.ts, which is at the 700-line cap. Same subject as its sibling
// validate-config-checklists.spec.ts: one pr-gate sub-section, validated on its own.

/**
 * `reviewerAgents` is REQUIRED for the same reason `mergeMode` and `required` are: it sets the PRICE of
 * every review round, and a price nobody chose is what makes a gate expensive enough to stop being run.
 * It used to be optional, where absent meant one SEPARATE subagent per checklist — so a repo with four
 * required checklists charged a one-line typo fix four full reviewer spawns, silently, never having asked.
 */
describe('validatePrGateSection — reviewerAgents (required cap)', () => {

    it('REQUIRES reviewerAgents — the price of a review round is never guessed', () => {
        const bad = validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO' });
        expect(bad.some(e => e.includes('Missing required field "reviewerAgents"'))).toBe(true);
    });

    // The missing-key message has to TEACH the number, because the reader has never seen this key: what 1
    // buys, what a higher number buys, and that there is deliberately no default.
    it('the missing-key error hands over the exact line AND what the number means', () => {
        const bad = validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO' });
        const msg = bad.find(e => e.includes('"reviewerAgents"')) ?? '';
        expect(msg).toContain('"reviewerAgents": 1,');
        expect(msg).toContain('0 = reviewer-agent reviews are disabled');
        expect(msg).toContain('ONE subagent reviews every owed checklist');
        expect(msg).toContain('deliberately no default');
    });

    it('accepts zero and positive integers', () => {
        for (const reviewerAgents of [0, 1, 2, 7]) {
            expect(validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO', reviewerAgents, maxReviewerRounds: 2 })).toEqual([]);
        }
    });

    it('rejects negatives, fractions, strings, null and booleans', () => {
        for (const reviewerAgents of [-1, 1.5, '1', null, true]) {
            const errors = validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO', reviewerAgents, maxReviewerRounds: 2 });
            expect(errors.some(e => e.includes('must be a nonnegative integer'))).toBe(true);
        }
    });
});
