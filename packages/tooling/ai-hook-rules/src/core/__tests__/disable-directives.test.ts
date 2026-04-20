/* eslint-disable @webpieces/max-method-lines -- test describe blocks are inherently large */
import { parseDirectives } from '../disable-directives';

describe('parseDirectives', () => {
    it('inline disable on same line as code', () => {
        const d = parseDirectives('const x: any = 1; // ai-hook-disable no-any-unknown -- legacy');
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'no-destructure')).toBe(false);
    });

    it('line-above disable affects next non-blank line', () => {
        const d = parseDirectives('// ai-hook-disable no-any-unknown -- reason\nconst x: any = 1;');
        expect(d.isLineDisabled(2, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(false);
    });

    it('skips blank lines before target', () => {
        const d = parseDirectives('// ai-hook-disable no-any-unknown -- reason\n\n\nconst x: any = 1;');
        expect(d.isLineDisabled(4, 'no-any-unknown')).toBe(true);
    });

    it('handles comma-separated rules', () => {
        const d = parseDirectives('const { a } = obj; // ai-hook-disable no-destructure, no-any-unknown -- reason');
        expect(d.isLineDisabled(1, 'no-destructure')).toBe(true);
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'other-rule')).toBe(false);
    });

    it('ai-hook-disable-next explicit form', () => {
        const d = parseDirectives('// ai-hook-disable-next no-any-unknown -- reason\nconst x: any = 1;');
        expect(d.isLineDisabled(2, 'no-any-unknown')).toBe(true);
    });

    it('ai-hook-disable-file within first 20 lines', () => {
        const src = '// ai-hook-disable-file no-any-unknown -- wraps API\nconst a = 1;\nconst b: any = 2;\nconst c: any = 3;';
        const d = parseDirectives(src);
        expect(d.isLineDisabled(3, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(4, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(3, 'no-destructure')).toBe(false);
    });

    it('ai-hook-disable-file beyond line 20 is ignored', () => {
        const filler = Array(25).fill('const a = 1;').join('\n');
        const src = filler + '\n// ai-hook-disable-file no-any-unknown -- too late\nconst x: any = 1;';
        const d = parseDirectives(src);
        expect(d.isLineDisabled(27, 'no-any-unknown')).toBe(false);
    });

    it('ai-hook-disable-all on its own line', () => {
        const d = parseDirectives('// ai-hook-disable-all -- hack\nconst x: any = 1;');
        expect(d.isLineDisabled(2, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(2, 'require-return-type')).toBe(true);
    });

    it('ai-hook-disable-all inline', () => {
        const d = parseDirectives('const x: any = 1; // ai-hook-disable-all -- hack');
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'anything-else')).toBe(true);
    });

    it('no directives present', () => {
        const d = parseDirectives('const x: any = 1;');
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(false);
    });

    it('star rule name matches anything', () => {
        const d = parseDirectives('const x: any = 1; // ai-hook-disable * -- nuclear');
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'require-return-type')).toBe(true);
    });

    it('directive without reason still parses', () => {
        const d = parseDirectives('const x: any = 1; // ai-hook-disable no-any-unknown');
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(true);
    });

    it('chained disable comments skip each other', () => {
        const src = '// ai-hook-disable no-any-unknown -- r1\n// ai-hook-disable no-destructure -- r2\nconst { a }: any = obj;';
        const d = parseDirectives(src);
        expect(d.isLineDisabled(3, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(3, 'no-destructure')).toBe(true);
    });

    it('webpieces-disable inline works same as ai-hook-disable', () => {
        const d = parseDirectives('const x: any = 1; // webpieces-disable no-any-unknown -- legacy');
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'no-destructure')).toBe(false);
    });

    it('webpieces-disable on line above', () => {
        const d = parseDirectives('// webpieces-disable no-any-unknown -- reason\nconst x: any = 1;');
        expect(d.isLineDisabled(2, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(1, 'no-any-unknown')).toBe(false);
    });

    it('webpieces-disable-file within first 20 lines', () => {
        const src = '// webpieces-disable-file no-any-unknown -- wraps API\nconst a = 1;\nconst b: any = 2;';
        const d = parseDirectives(src);
        expect(d.isLineDisabled(3, 'no-any-unknown')).toBe(true);
    });

    it('webpieces-disable-all suppresses all rules', () => {
        const d = parseDirectives('// webpieces-disable-all -- hack\nconst x: any = 1;');
        expect(d.isLineDisabled(2, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(2, 'require-return-type')).toBe(true);
    });

    it('webpieces-disable chained with ai-hook-disable', () => {
        const src = '// webpieces-disable no-any-unknown -- r1\n// ai-hook-disable no-destructure -- r2\nconst { a }: any = obj;';
        const d = parseDirectives(src);
        expect(d.isLineDisabled(3, 'no-any-unknown')).toBe(true);
        expect(d.isLineDisabled(3, 'no-destructure')).toBe(true);
    });
});
