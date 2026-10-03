import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { FileContext, NormalizedEdit, NormalizedToolInput, ProposedFile, ToolKind } from '@webpieces/hook-runtime';
import { SourceContributionConfig } from '../source-contribution-config';
import { NoAnyUnknownRule } from './no-any-unknown';

describe('no-any-unknown before writing a complete proposed file', () => {
    const root = specTempDirs.make('wp-hook-type-keywords-');

    function context(original: string, edits: readonly NormalizedEdit[], tool: ToolKind = 'Edit'): FileContext {
        const file = path.join(root, 'contract.ts');
        fs.writeFileSync(file, original);
        const input = new NormalizedToolInput(file, edits);
        return new FileContext(tool, file, 'src/contract.ts', root, new ProposedFile(tool, input), 0, 0, 0, 0);
    }

    function rule(mode: string = 'NEW_AND_MODIFIED_CODE', disableAllowed: boolean = false): NoAnyUnknownRule {
        const config = new SourceContributionConfig();
        config.mode = mode;
        config.disableAllowed = disableAllowed;
        return new NoAnyUnknownRule(config);
    }

    it('detects a bare unknown replacement inside a multiline generic in full-file context', () => {
        const ctx = context('type Payload = CustomBox<\n string\n>;', [new NormalizedEdit('string', 'unknown', false)]);
        expect(rule().check(ctx)).toMatchObject([{ line: 2, message: expect.stringContaining('`unknown`') }]);
    });

    it('detects aliases and arbitrary generic any forms missed by the old regex', () => {
        const ctx = context('', [new NormalizedEdit('', 'type A = any;\ntype B = CustomBox<any>;', false)], 'Write');
        expect(rule().check(ctx)).toHaveLength(2);
    });

    it('grandfathers untouched keyword types in line mode, but checks the whole file in file mode', () => {
        const ctx = context('type Legacy = unknown;\nconst count = 1;', [new NormalizedEdit('1', '2', false)]);
        expect(rule().check(ctx)).toEqual([]);
        expect(rule('NEW_AND_MODIFIED_FILES').check(ctx)).toHaveLength(1);
    });

    it('honors directives outside the replacement snippet only when allowed', () => {
        const ctx = context('// webpieces-disable no-any-unknown -- explicit boundary\ntype Payload = string;',
            [new NormalizedEdit('string', 'unknown', false)]);
        expect(rule('NEW_AND_MODIFIED_CODE', true).check(ctx)).toEqual([]);
        expect(rule().check(ctx)).toHaveLength(1);
    });

    it('checks final MultiEdit content, allowing an intermediate type removed in the same call', () => {
        const ctx = context('type Payload = string;', [new NormalizedEdit('string', 'unknown', false),
            new NormalizedEdit('unknown', 'ActualDto', false)], 'MultiEdit');
        expect(rule().check(ctx)).toEqual([]);
    });

    it('preserves the catch-variable exception without exempting unknown in the body', () => {
        const ctx = context('', [new NormalizedEdit('', 'try {} catch (err: unknown) { const value: unknown = err; }', false)], 'Write');
        expect(rule().check(ctx)).toHaveLength(1);
    });

    it('guides the AI to think about actual data and use concrete types', () => {
        expect(rule().description).toContain('both `any` and `unknown`');
        expect(JSON.stringify(rule().fixHint)).not.toContain('unknown` with type guards');
        expect(JSON.stringify(rule().fixHint)).toContain('concrete type');
    });
});
