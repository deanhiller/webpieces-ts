import { SourceContributionConfig } from "../source-contribution-config";


import { FileContext, NormalizedEdit, NormalizedToolInput, ProposedFile } from '@webpieces/hook-runtime';
import { NoAnyUnknownRule } from './no-any-unknown';

function ctxWithDisableActive(): FileContext {
    const input = new NormalizedToolInput('/tmp/wp-type-keyword-fixture.ts', [new NormalizedEdit('',
        '// webpieces-disable no-any-unknown -- test suppression\nconst x: any = foo();', false)]);
    return new FileContext('Write', input.filePath, 'x.ts', '/tmp', new ProposedFile('Write', input), 0, 2, 0, 2);
}

describe('disableAllowed enforcement (ai-hook side honours the team config)', () => {
    it('disableAllowed:true (default) → a webpieces-disable comment suppresses the rule', () => {
        const rule = new NoAnyUnknownRule(new SourceContributionConfig());
        expect(rule.check(ctxWithDisableActive())).toHaveLength(0);
        // The fix report offers the escape.
        expect(rule.fixHint.escape?.allowed).toBe(true);
    });

    it('disableAllowed:false → the rule still fires even with a webpieces-disable comment', () => {
        const config = new SourceContributionConfig();
        config.disableAllowed = false;
        const rule = new NoAnyUnknownRule(config);
        expect(rule.check(ctxWithDisableActive())).toHaveLength(1);
        // The fix report blocks the escape (drives the "must be followed" line).
        expect(rule.fixHint.escape?.allowed).toBe(false);
    });
});
