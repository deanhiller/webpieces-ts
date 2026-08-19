import { describe, it, expect } from 'vitest';

import { NoCustomCssConfig } from './rule-configs';
import { NoCustomCssScope } from './no-custom-css-scope';

function scope(allowGlobs?: string[]): NoCustomCssScope {
    const cfg = new NoCustomCssConfig();
    cfg.mode = 'NEW_AND_MODIFIED_FILES';
    if (allowGlobs !== undefined) cfg.allowGlobs = allowGlobs;
    return new NoCustomCssScope(cfg);
}

describe('NoCustomCssScope', () => {
    it('exempts nothing but test sources when allowGlobs is absent', () => {
        const s = scope();
        expect(s.isExempt('services/x/design.html')).toBe(false);
        expect(s.isExempt('src/app/a.component.html')).toBe(false);
    });

    it('exempts test sources always', () => {
        const s = scope();
        expect(s.isExempt('src/foo.spec.ts')).toBe(true);
        expect(s.isExempt('src/foo.test.ts')).toBe(true);
        expect(s.isExempt('src/__tests__/foo.ts')).toBe(true);
    });

    it('exempts a path a configured glob matches, at any depth', () => {
        const s = scope(['**/design.html']);
        expect(s.isExempt('services/grubhub-integration/design.html')).toBe(true);
        expect(s.isExempt('design.html')).toBe(true);
        expect(s.isExempt('services/grubhub-integration/other.html')).toBe(false);
    });

    it('treats a bare directory pattern as a prefix', () => {
        const s = scope(['libraries/angular/fuse-angular']);
        expect(s.isExempt('libraries/angular/fuse-angular/a.component.html')).toBe(true);
        expect(s.isExempt('libraries/angular/mine/a.component.html')).toBe(false);
    });

    it('does NOT let a `**\\/name` glob match a longer filename ending in that name', () => {
        // The hand-rolled globToRegex this replaced compiled `**\/design.html` to `.*design.html`, so
        // `my-design.html` matched too. minimatch anchors the segment.
        const s = scope(['**/design.html']);
        expect(s.isExempt('services/x/my-design.html')).toBe(false);
    });

    it('normalises Windows separators before matching', () => {
        const s = scope(['**/design.html']);
        expect(s.isExempt('services\\x\\design.html')).toBe(true);
    });
});
