import { describe, expect, it } from 'vitest';
import { SiteDisables } from './source-syntax';

describe('SiteDisables — one rule\'s per-site disables and their written reasons', () => {
    it('targets the same line after code, or the next code line from a line of its own', () => {
        const disables = new SiteDisables([
            'a(); // webpieces-disable my-rule -- reason on the same line as the code',
            '// webpieces-disable other-rule, my-rule -- aimed at the line below it',
            '',
            '// webpieces-disable unrelated -- skipped while looking for the target',
            'b();',
            '// webpieces-disable my-rule',
            'c();',
            'd(); // webpieces-disable not-mine -- another rule entirely',
        ].join('\n'), 'my-rule');
        expect(disables.reasonAt(1)).toBe('reason on the same line as the code');
        expect(disables.reasonAt(5)).toBe('aimed at the line below it');
        expect(disables.reasonAt(7)).toBe('');
        expect(disables.reasonAt(8)).toBeUndefined();
    });
});
