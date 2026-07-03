import { NoAnyUnknownConfig } from '@webpieces/rules-config';

import { EditContext } from '../types';
import { NoAnyUnknownRule } from './no-any-unknown';

// A single `: any` line that a webpieces-disable comment would normally suppress.
// isLineDisabled always returns true here to simulate that suppression being present.
function ctxWithDisableActive(): EditContext {
    const lines = ['const x: any = foo();'];
    return new EditContext(
        'Edit', 0, 1, '/w/x.ts', 'x.ts', '/w',
        lines.join('\n'), lines.join('\n'), lines, lines, '',
        (): boolean => true,
    );
}

describe('disableAllowed enforcement (ai-hook side honours the team config)', () => {
    it('disableAllowed:true (default) → a webpieces-disable comment suppresses the rule', () => {
        const rule = new NoAnyUnknownRule(new NoAnyUnknownConfig());
        expect(rule.check(ctxWithDisableActive())).toHaveLength(0);
        // The fix report offers the escape.
        expect(rule.fixHint.escape?.allowed).toBe(true);
    });

    it('disableAllowed:false → the rule still fires even with a webpieces-disable comment', () => {
        const config = new NoAnyUnknownConfig();
        config.disableAllowed = false;
        const rule = new NoAnyUnknownRule(config);
        expect(rule.check(ctxWithDisableActive())).toHaveLength(1);
        // The fix report blocks the escape (drives the "must be followed" line).
        expect(rule.fixHint.escape?.allowed).toBe(false);
    });
});
