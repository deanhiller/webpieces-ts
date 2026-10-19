import { describe, it, expect } from 'vitest';

import { TurnOffRuleCure } from '@webpieces/rules-config';

import { disableNotAllowedLines } from '../validate-modified-methods';

// #1318: the max-method-lines guidance printed when disableAllowed is false used to send a human to
// "nx.json validate-code options" with an "epoch ms" expiry — both wrong (the entry lives in the owner rule
// file, and the epoch is SECONDS), and a future epoch is REPO-WIDE. The BRANCH hatch now leads.
describe('max-method-lines: guidance when disableAllowed is false', () => {
    const NOW = 1_800_000_000;
    const text = disableNotAllowedLines(new TurnOffRuleCure((): number => NOW)).join('\n');

    it('leads with turnOffRuleWhileOnBranch and keeps the epoch at 0', () => {
        expect(text).toContain('"turnOffRuleWhileOnBranch": "<exact branch name>"');
        expect(text).toContain('"turnOffRuleUntilEpoch": 0');
        expect(text).toContain('Fix Option 1: (preferred) Turn the rule off for THIS BRANCH ONLY');
        expect(text).toContain('Fix Option 2: LAST RESORT');
        expect(text).not.toContain('Preferred:');
    });

    it('gives the epoch only as a +1 hour, REPO-WIDE last resort in epoch SECONDS', () => {
        expect(text).toContain('now + 1 hour, in epoch SECONDS');
        expect(text).toContain(String(NOW + 3600));
        expect(text).toContain('REPO-WIDE');
    });

    it('points at the owner rule file, never nx.json, and never says epoch ms', () => {
        expect(text).toContain('.webpieces-config/rules/code-rules.json');
        expect(text).not.toContain('nx.json');
        expect(text).not.toMatch(/epoch ms/i);
    });
});
