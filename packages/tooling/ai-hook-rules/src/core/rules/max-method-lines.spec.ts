import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { FileContext, NormalizedEdit, NormalizedToolInput, ProposedFile, ToolKind } from '@webpieces/hook-runtime';
import { SourceContributionConfig } from '../source-contribution-config';
import { sourceAnalysis } from '../source-analysis';
import { MaxMethodLinesRule } from './max-method-lines';
import { NoAnyUnknownRule } from './no-any-unknown';

describe('method size before writing', () => {
    const root = specTempDirs.make('wp-hook-method-lines-');

    function method(name: string, size: number): string {
        return `${name}(): void {\n${Array(size - 2).fill('    void 0;').join('\n')}\n}`;
    }

    function context(original: string, edits: readonly NormalizedEdit[], tool: ToolKind = 'Edit'): FileContext {
        const file = path.join(root, 'service.ts');
        fs.writeFileSync(file, original);
        const input = new NormalizedToolInput(file, edits);
        return new FileContext(tool, file, 'src/service.ts', root, new ProposedFile(tool, input), 0, 0, 0, 0);
    }

    function rule(mode: string = 'NEW_AND_MODIFIED_METHODS', disableAllowed: boolean = false): MaxMethodLinesRule {
        const config = new SourceContributionConfig();
        config.mode = mode;
        config.limit = 80;
        config.disableAllowed = disableAllowed;
        return new MaxMethodLinesRule(config);
    }

    it.each([80, 81])('enforces the exact boundary for a new %s-line method', (size: number): void => {
        const ctx = context('', [new NormalizedEdit('', `class Service {\n${method('run', size)}\n}`, false)], 'Write');
        expect(rule().check(ctx)).toHaveLength(size > 80 ? 1 : 0);
    });

    it('denies a tiny insertion that pushes its enclosing method over the limit', () => {
        const original = `class Service {\n${method('run', 80)}\n}`;
        const ctx = context(original, [new NormalizedEdit('run(): void {', 'run(): void {\n    void 1;', false)]);
        expect(rule().check(ctx)).toMatchObject([{ line: 2, snippet: 'run', message: expect.stringContaining('81 lines') }]);
    });

    it('grandfathers untouched legacy methods through line shifts and complete writes', () => {
        const original = `class Service {\n${method('legacy', 90)}\n${method('small', 3)}\n}`;
        const edits = [new NormalizedEdit('small(): void {', 'small(): void {\n    void 1;', false)];
        expect(rule().check(context(original, edits))).toEqual([]);
        const complete = original.replace('small(): void {', 'small(): void {\n    void 1;');
        expect(rule().check(context(original, [new NormalizedEdit('', complete, false)], 'Write'))).toEqual([]);
        expect(rule('NEW_AND_MODIFIED_FILES').check(context(original, edits))).toHaveLength(1);
    });

    it('requires a touched oversized legacy method to be refactored', () => {
        const ctx = context(`class Service {\n${method('legacy', 90)}\n}`,
            [new NormalizedEdit('legacy(): void {', 'legacy(): void {\n    void 1;', false)]);
        expect(rule().check(ctx)).toHaveLength(1);
        expect(rule('NEW_METHODS').check(ctx)).toEqual([]);
    });

    it('measures the final MultiEdit result after an insertion and matching removal', () => {
        const original = `class Service {\n${method('run', 80)}\n}`;
        const ctx = context(original, [new NormalizedEdit('run(): void {', 'run(): void {\n    void 1;', false),
            new NormalizedEdit('    void 1;\n', '', false)], 'MultiEdit');
        expect(rule().check(ctx)).toEqual([]);
    });

    it('never permits a directive when disableAllowed is false', () => {
        const text = `class Service {\n// webpieces-disable max-lines-modified XXXX/XX/XX -- boundary\n${method('run', 81)}\n}`;
        const ctx = context('', [new NormalizedEdit('', text, false)], 'Write');
        expect(rule().check(ctx)).toHaveLength(1);
        expect(rule('NEW_AND_MODIFIED_METHODS', true).check(ctx)).toEqual([]);
    });

    it('reuses the proposed source parse across both syntax rules', () => {
        const ctx = context('', [new NormalizedEdit('', 'class Service { run(): void {} }', false)], 'Write');
        const parsed = sourceAnalysis.forFile(ctx).proposed;
        rule().check(ctx);
        const config = new SourceContributionConfig();
        config.mode = 'NEW_AND_MODIFIED_CODE';
        new NoAnyUnknownRule(config).check(ctx);
        expect(sourceAnalysis.forFile(ctx).proposed).toBe(parsed);
    });
});
