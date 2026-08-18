import { describe, it, expect } from 'vitest';

import { validateWebpiecesConfig, validateMatchRulesSection, MAX_TURN_OFF_EPOCH_DAYS } from './validate-config';

// Errors mentioning a given rule name.
function errorsFor(rule: string, errors: string[]): string[] {
    return errors.filter(e => e.includes(`[${rule}]`));
}

// A minimal valid match-rule entry, cloned + tweaked per test.
// webpieces-disable no-any-unknown -- a config FIXTURE, handed straight to the validator as opaque JSON
function validMatchRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        name: 'no-fetch',
        patterns: ['(?<![.\\w])fetch\\s*\\('],
        mainMessage: 'Use the generated client instead.',
        mode: 'NEW_AND_MODIFIED_CODE',
        turnOffRuleUntilEpoch: 0,
        turnOffRuleWhileOnBranch: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------------------------------
// turnOffRuleUntilEpoch is capped at MAX_TURN_OFF_EPOCH_DAYS days into the future. The epoch hatch is
// REPO-WIDE while it lasts, so a long window silently shelters every unrelated change landing inside it —
// a fleet repo was found with max-file-lines/max-method-lines off until 2026-10-01, 43 days out. Renewing
// it WEEKLY is the intended workflow. The BRANCH hatch is deliberately uncapped (see the constant's docstring).
// ---------------------------------------------------------------------------------------------------
describe('turnOffRuleUntilEpoch is capped at one week out', () => {
    const DAY = 24 * 60 * 60;
    const nowSeconds = (): number => Math.floor(Date.now() / 1000);

    function capErrors(epoch: number): string[] {
        return errorsFor('no-file-import-cycles', validateWebpiecesConfig({
            'no-file-import-cycles': {
                mode: 'RUN_EVERY_TIME',
                turnOffRuleUntilEpoch: epoch,
                turnOffRuleWhileOnBranch: null,
            },
        })).filter(e => e.includes('turnOffRuleUntilEpoch'));
    }

    // Every existing config is full of these; they are inert (they skip nothing) and must stay valid.
    it('accepts an epoch in the PAST', () => {
        expect(capErrors(nowSeconds() - 30 * DAY)).toEqual([]);
    });

    it('accepts 0, the documented "rule is active" value', () => {
        expect(capErrors(0)).toEqual([]);
    });

    it('accepts 6 days out', () => {
        expect(capErrors(nowSeconds() + 6 * DAY)).toEqual([]);
    });

    // BOUNDARY: inclusive. "now + exactly MAX days" is what an agent computing the maximum writes, and it
    // must not be rejected by the second it took to save the file.
    it('accepts exactly MAX_TURN_OFF_EPOCH_DAYS out (the boundary is inclusive)', () => {
        expect(capErrors(nowSeconds() + MAX_TURN_OFF_EPOCH_DAYS * DAY)).toEqual([]);
    });

    it('REJECTS 8 days out, and the message carries the cure', () => {
        const [msg] = capErrors(nowSeconds() + 8 * DAY);

        expect(msg).toContain('the maximum is 7 days');
        expect(msg).toContain('CURE:');
        expect(msg).toMatch(/re-set it WEEKLY/);
        // The largest acceptable epoch AND its human date, so the fix is a copy-paste.
        expect(msg).toMatch(/set it to at most \d{10} \(\d{4}-\d{2}-\d{2}\)/);
    });

    it('REJECTS the 43-day window this cap exists to catch', () => {
        expect(capErrors(nowSeconds() + 43 * DAY)).toHaveLength(1);
    });

    it('caps a match-rules entry the same way', () => {
        const errors = validateMatchRulesSection([validMatchRule({ turnOffRuleUntilEpoch: nowSeconds() + 43 * DAY })]);

        expect(errors.some(e => e.includes('the maximum is 7 days'))).toBe(true);
    });

    // The asymmetry is the design, not an oversight: a refactor branch may legitimately run 35+ days.
    it('does NOT cap turnOffRuleWhileOnBranch in any way', () => {
        const errors = errorsFor('no-file-import-cycles', validateWebpiecesConfig({
            'no-file-import-cycles': {
                mode: 'RUN_EVERY_TIME',
                turnOffRuleUntilEpoch: 0,
                turnOffRuleWhileOnBranch: 'dean/a-very-long-refactor',
            },
        }));

        expect(errors.filter(e => e.includes('turnOffRuleWhileOnBranch'))).toEqual([]);
    });
});
