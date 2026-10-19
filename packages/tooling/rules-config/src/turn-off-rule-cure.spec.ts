import { describe, it, expect } from 'vitest';

import { TurnOffRuleCure, LAST_RESORT_TURN_OFF_SECONDS } from './turn-off-rule-cure';

// #1318: shouldSkipRule ORs the two hatches, so a future epoch turns a rule off for the WHOLE repo. Every
// turn-off cure therefore leads with the BRANCH hatch and offers the epoch only as a +1 hour last resort.
describe('TurnOffRuleCure', () => {
    const NOW = 1_800_000_000;
    const cure = new TurnOffRuleCure((): number => NOW);
    const ENTRY = 'the "max-file-lines" entry in .webpieces-config/rules/code-rules.json';

    it('leads with turnOffRuleWhileOnBranch, preferred, and keeps the epoch at 0', () => {
        const options = cure.options(ENTRY);
        expect(options[0]?.preferred).toBe(true);
        expect(options[0]?.text).toContain('"turnOffRuleWhileOnBranch": "<exact branch name>"');
        expect(options[0]?.text).toContain('"turnOffRuleUntilEpoch": 0');
        expect(options[0]?.text).toContain(ENTRY);
    });

    it('fills in the exact branch when the caller knows it, never a detached HEAD', () => {
        expect(cure.byBranchText(ENTRY, 'dean/port-legacy')).toContain('"turnOffRuleWhileOnBranch": "dean/port-legacy"');
        expect(cure.byBranchText(ENTRY, 'HEAD')).toContain('"<exact branch name>"');
        expect(cure.byBranchText(ENTRY, null)).toContain('"<exact branch name>"');
    });

    it('gives the epoch as now + 1 hour in SECONDS, as a last resort that is REPO-WIDE', () => {
        const options = cure.options(ENTRY);
        const epoch = options[1]?.text ?? '';
        expect(options[1]?.preferred).toBe(false);
        expect(LAST_RESORT_TURN_OFF_SECONDS).toBe(3600);
        expect(epoch).toContain('LAST RESORT');
        expect(epoch).toContain('now + 1 hour, in epoch SECONDS');
        expect(epoch).toContain(String(NOW + 3600));
        expect(epoch).toContain('REPO-WIDE');
        expect(epoch).toMatch(/detached-HEAD/);
        expect(epoch).toMatch(/pull_request_target/);
    });

    it('names neither nx.json nor epoch milliseconds', () => {
        const all = cure.options(ENTRY).map((o): string => o.text).join('\n');
        expect(all).not.toContain('nx.json');
        expect(all).not.toMatch(/epoch ms|millisecond/i);
    });
});
