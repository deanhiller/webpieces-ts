import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { NormalizedEdit, NormalizedToolInput } from '../protocol';
import { ApplyPatchParser } from './apply-patch-parse';
import { ProposedFile } from './proposed-file';

describe('proposed complete file before write', () => {
    const root = specTempDirs.make('wp-proposed-file-');

    function input(original: string, edits: readonly NormalizedEdit[]): NormalizedToolInput {
        const file = path.join(root, 'service.ts');
        fs.writeFileSync(file, original);
        return new NormalizedToolInput(file, edits);
    }

    it('projects sequential edits and keeps earlier changed ranges after shifts without writing', () => {
        const original = 'type Old = unknown;\nconst n = 1;\nconst s = "x";';
        const operation = input(original, [new NormalizedEdit('const n = 1;', 'const n: any = 1;', false),
            new NormalizedEdit('type Old = unknown;\n', '', false)]);
        const proposed = new ProposedFile('MultiEdit', operation);
        expect(proposed.read().text).toBe('const n: any = 1;\nconst s = "x";');
        expect(proposed.read().changedLines()).toEqual(new Set([1]));
        expect(fs.readFileSync(operation.filePath, 'utf8')).toBe(original);
        expect(proposed.read()).toBe(proposed.read());
    });

    it('checks final content when a later edit removes an intermediate violation', () => {
        const operation = input('type Value = string;', [new NormalizedEdit('string', 'unknown', false),
            new NormalizedEdit('unknown', 'ActualDto', false)]);
        expect(new ProposedFile('MultiEdit', operation).read().text).toBe('type Value = ActualDto;');
    });

    it('does not mark unchanged context modified when a later edit is a no-op', () => {
        const original = 'type Legacy = unknown;\nconst value = 1;';
        const final = original.replace('1', '2');
        const operation = input(original, [new NormalizedEdit('1', '2', false), new NormalizedEdit(final, final, false)]);
        expect(new ProposedFile('MultiEdit', operation).read().changedLines()).toEqual(new Set([2]));
    });

    it('honors replace_all and refuses ambiguous single-location edits', () => {
        const operation = input('type A = string;\ntype B = string;', [new NormalizedEdit('string', 'unknown', true)]);
        expect(new ProposedFile('Edit', operation).read().text).toBe('type A = unknown;\ntype B = unknown;');
        const ambiguous = new ProposedFile('Edit', input('x x', [new NormalizedEdit('x', 'y', false)]));
        expect(() => ambiguous.read()).toThrow('multiple locations');
    });

    it('refuses stale context instead of checking guessed content', () => {
        const proposed = new ProposedFile('Edit', input('actual', [new NormalizedEdit('stale', 'new', false)]));
        expect(() => proposed.read()).toThrow('does not match');
    });

    it('preserves source content for moved Codex files while judging the destination', () => {
        fs.writeFileSync(path.join(root, 'original.ts'), 'type Payload = string;\n');
        const operation = new ApplyPatchParser().parse('*** Begin Patch\n*** Update File: original.ts\n*** Move to: moved.ts\n@@\n-type Payload = string;\n+type Payload = unknown;\n*** End Patch', root)[0];
        expect(operation.input.filePath).toBe(path.join(root, 'moved.ts'));
        expect(new ProposedFile(operation.toolKind, operation.input).read().text).toBe('type Payload = unknown;\n');
    });
});
