import { describe, it, expect } from 'vitest';

import { NoCustomCssConfig } from '@webpieces/rules-config';

import { EditContext } from '../types';
import { NoCustomCssRule } from './no-custom-css';

function ctx(relativePath: string, content: string, disabledLines: number[] = []): EditContext {
    const lines = content.split('\n');
    const disabled = new Set(disabledLines);
    return new EditContext(
        'Write',
        0,
        1,
        `/tmp/x/${relativePath}`,
        relativePath,
        '/tmp/x',
        content,
        content,
        lines,
        lines, // strippedLines — fine for these tests (no // comments in the snippets)
        '',
        (lineNum: number): boolean => disabled.has(lineNum),
    );
}

function rule(allowGlobs: string[] = []): NoCustomCssRule {
    const cfg = new NoCustomCssConfig();
    cfg.mode = 'NEW_AND_MODIFIED_CODE';
    cfg.allowGlobs = allowGlobs;
    return new NoCustomCssRule(cfg);
}

describe('NoCustomCssRule (.ts)', () => {
    it('flags styleUrls in a component', () => {
        const v = rule().check(ctx('src/foo.component.ts', `@Component({ styleUrls: ['./foo.css'] })`));
        expect(v).toHaveLength(1);
        expect(v[0].snippet).toContain('styleUrls');
    });

    it('flags a styles: [ block', () => {
        const v = rule().check(ctx('src/foo.component.ts', `@Component({ styles: ['.a{}'] })`));
        expect(v).toHaveLength(1);
    });

    it('does not flag a Tailwind-only component', () => {
        const v = rule().check(ctx('src/foo.component.ts', `@Component({ template: '<div class="flex"></div>' })`));
        expect(v).toHaveLength(0);
    });
});

describe('NoCustomCssRule (.html)', () => {
    it('flags inline style=', () => {
        const v = rule().check(ctx('src/foo.component.html', `<div style="color:red"></div>`));
        expect(v).toHaveLength(1);
        expect(v[0].snippet).toContain('style=');
    });

    it('flags [style.width] and [ngStyle]', () => {
        expect(rule().check(ctx('a.html', `<div [style.width]="w"></div>`))).toHaveLength(1);
        expect(rule().check(ctx('a.html', `<div [ngStyle]="s"></div>`))).toHaveLength(1);
    });

    it('does not flag Tailwind classes / [class.x]', () => {
        expect(rule().check(ctx('a.html', `<div class="flex" [class.on]="x"></div>`))).toHaveLength(0);
    });
});

describe('NoCustomCssRule escapes', () => {
    it('respects a disabled line', () => {
        const v = rule().check(ctx('a.html', `<div style="x"></div>`, [1]));
        expect(v).toHaveLength(0);
    });

    it('skips a file under allowGlobs', () => {
        const v = rule(['**/fuse-angular/**']).check(ctx('libraries/angular/fuse-angular/a.component.html', `<div style="x"></div>`));
        expect(v).toHaveLength(0);
    });

    it('skips test files', () => {
        const v = rule().check(ctx('src/foo.spec.ts', `@Component({ styleUrls: ['x'] })`));
        expect(v).toHaveLength(0);
    });
});
