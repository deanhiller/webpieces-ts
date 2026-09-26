import { describe, expect, it } from 'vitest';
import { buildPrGateConfig } from './pr-gate-config';
import { validatePrGateSection } from './validate-config';

function valid(maxReviewerRounds: unknown): Record<string, unknown> {
    return { mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO', reviewerAgents: 1, maxReviewerRounds };
}

describe('validatePrGateSection — maxReviewerRounds', () => {
    it('requires an explicit repository-owned round budget', () => {
        const errors = validatePrGateSection({ mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO', reviewerAgents: 1 });
        expect(errors.some((e: string): boolean => e.includes('Missing required field "maxReviewerRounds"'))).toBe(true);
        expect(errors.join('\n')).toContain('"maxReviewerRounds": 2');
    });

    it('accepts positive integers, including while reviewers are disabled', () => {
        for (const maxReviewerRounds of [1, 2, 7]) expect(validatePrGateSection(valid(maxReviewerRounds))).toEqual([]);
        expect(validatePrGateSection({ ...valid(2), reviewerAgents: 0 })).toEqual([]);
    });

    it('rejects zero, negative, fractional and non-numeric values', () => {
        for (const value of [0, -1, 1.5, '2', null, true]) {
            expect(validatePrGateSection(valid(value)).join('\n')).toContain('must be a positive integer');
        }
    });

    it('does not silently restore a missing value during config construction', () => {
        expect(buildPrGateConfig(valid(7)).maxReviewerRounds).toBe(7);
        expect(buildPrGateConfig({ mode: 'ON', buildCommand: 'x', mergeMode: 'AUTO', reviewerAgents: 1 }).maxReviewerRounds)
            .toBeUndefined();
    });
});
