/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import { stripTsNoise } from '../strip-ts-noise';

describe('stripTsNoise', () => {
    it('passes code through unchanged', () => {
        const src = 'const x: number = 1;\nconst y = x + 2;\n';
        expect(stripTsNoise(src)).toBe(src);
    });

    it('preserves line count for all inputs', () => {
        const cases = [
            'a\nb\nc',
            '// comment\nconst x = 1;',
            '/* multi\n   line\n   comment */\nconst x = 1;',
            '"string with\\nescaped newline"',
            '`template\nwith\nnewlines`',
            '"multi\nline"\nconst y = 2;',
        ];
        for (const src of cases) {
            const out = stripTsNoise(src);
            expect(out.split('\n').length).toBe(src.split('\n').length);
            expect(out.length).toBe(src.length);
        }
    });

    it('replaces double-quoted string interior with spaces', () => {
        const src = 'const x = "has any keyword";';
        const out = stripTsNoise(src);
        expect(out).not.toContain('any');
    });

    it('replaces single-quoted string interior', () => {
        const src = "const x = 'any';";
        const out = stripTsNoise(src);
        expect(out).not.toContain('any');
    });

    it('handles escaped quotes inside strings', () => {
        const src = 'const x = "has \\"any\\" keyword";';
        const out = stripTsNoise(src);
        expect(out).not.toContain('any');
    });

    it('replaces line comment body with spaces', () => {
        const src = '// this has any in it\nconst x = 1;';
        const out = stripTsNoise(src);
        expect(out.split('\n')[0]).not.toContain('any');
    });

    it('replaces block comment body, preserves newlines', () => {
        const src = '/* line1 any\n   line2 any */\nconst x = 1;';
        const out = stripTsNoise(src);
        expect(out).not.toContain('any');
        expect(out.split('\n').length).toBe(3);
    });

    it('strips template literal body but keeps ${} interp as code', () => {
        const src = 'const x = `prefix ${value + 1} suffix any`;';
        const out = stripTsNoise(src);
        expect(out).not.toMatch(/prefix/);
        expect(out).not.toMatch(/ any`/);
        expect(out).toMatch(/\$\{value \+ 1\}/);
    });

    it('handles nested template inside interpolation', () => {
        const src = 'const x = `outer ${`inner ${y} end`} done`;';
        const out = stripTsNoise(src);
        expect(out).toMatch(/\$\{y\}/);
        expect(out).not.toMatch(/outer/);
        expect(out).not.toMatch(/inner/);
        expect(out).not.toMatch(/end/);
        expect(out).not.toMatch(/done/);
    });

    it('strips string inside template interpolation', () => {
        const src = 'const x = `prefix ${"some any string"} suffix`;';
        const out = stripTsNoise(src);
        expect(out).not.toContain('some any string');
    });

    it('keeps any keyword in real code visible', () => {
        const src = 'const x: any = 1;\nconst y: number = 2;';
        const out = stripTsNoise(src);
        expect(out).toContain(': any');
        expect(out).toContain(': number');
    });

    it('hides any keyword inside comment', () => {
        const src = 'const x: number = 1; // this returns any maybe';
        const out = stripTsNoise(src);
        expect(out).toContain(': number');
        expect(out.indexOf('any')).toBe(-1);
    });

    it('does not treat division as a comment', () => {
        const src = 'const x = a / b;\nconst y = c / d;';
        expect(stripTsNoise(src)).toBe(src);
    });

    it('handles empty input', () => {
        expect(stripTsNoise('')).toBe('');
    });

    it('does not bleed comment into next line', () => {
        const src = '// disable rule\nconst x: any = 1;';
        const out = stripTsNoise(src);
        expect(out).toContain(': any');
    });
});
