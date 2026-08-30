import { describe, it, expect } from 'vitest';

import { ApplyPatchParser } from './apply-patch-parse';
import { FileOperation } from './agent-event';
import { InformAiError } from './types';

const CWD = '/repo/sub';
const parser = new ApplyPatchParser();

function kinds(ops: readonly FileOperation[]): readonly string[] {
    return ops.map((o: FileOperation): string => o.toolKind);
}
function paths(ops: readonly FileOperation[]): readonly string[] {
    return ops.map((o: FileOperation): string => o.input.filePath);
}

describe('ApplyPatchParser', () => {
    it('maps *** Add File: to a Write of the joined + lines', () => {
        const ops = parser.parse('*** Begin Patch\n*** Add File: agent-a.txt\n+one\n+two\n*** End Patch', CWD);
        expect(kinds(ops)).toEqual(['Write']);
        expect(paths(ops)).toEqual(['/repo/sub/agent-a.txt']);
        expect(ops[0].input.edits).toHaveLength(1);
        expect(ops[0].input.edits[0].oldString).toBe('');
        expect(ops[0].input.edits[0].newString).toBe('one\ntwo');
    });

    it('maps *** Delete File: to a Delete with no body', () => {
        const ops = parser.parse('*** Begin Patch\n*** Delete File: /abs/gone.ts\n*** End Patch', CWD);
        expect(kinds(ops)).toEqual(['Delete']);
        expect(paths(ops)).toEqual(['/abs/gone.ts']);
        expect(ops[0].input.edits).toHaveLength(0);
    });

    it('maps *** Update File: to one NormalizedEdit per bare @@ hunk', () => {
        const patch = [
            '*** Begin Patch',
            '*** Update File: a.ts',
            '@@',
            ' 1',
            '-2',
            '+SECOND',
            ' 3',
            '@@',
            ' x',
            '+y',
            '*** End Patch',
        ].join('\n');
        const ops = parser.parse(patch, CWD);
        expect(kinds(ops)).toEqual(['Edit']);
        expect(ops[0].input.edits).toHaveLength(2);
        // old = the ' ' and '-' lines; new = the ' ' and '+' lines.
        expect(ops[0].input.edits[0].oldString).toBe('1\n2\n3');
        expect(ops[0].input.edits[0].newString).toBe('1\nSECOND\n3');
        expect(ops[0].input.edits[1].oldString).toBe('x');
        expect(ops[0].input.edits[1].newString).toBe('x\ny');
    });

    it('treats a bare empty line inside a hunk as an empty CONTEXT line', () => {
        const ops = parser.parse('*** Begin Patch\n*** Update File: a.ts\n@@\n a\n\n+b\n*** End Patch', CWD);
        expect(ops[0].input.edits[0].oldString).toBe('a\n');
        expect(ops[0].input.edits[0].newString).toBe('a\n\nb');
    });

    it('*** Move to: makes the DESTINATION the judged path', () => {
        const ops = parser.parse('*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch', CWD);
        expect(paths(ops)).toEqual(['/repo/sub/new.ts']);
    });

    it('carries MANY files with MIXED operations out of ONE envelope', () => {
        const patch = [
            '*** Begin Patch',
            '*** Add File: added.txt',
            '+hello',
            '*** Update File: /repo/sub/changed.ts',
            '@@',
            '-a',
            '+b',
            '*** Delete File: dropped.md',
            '*** End Patch',
        ].join('\n');
        const ops = parser.parse(patch, CWD);
        expect(kinds(ops)).toEqual(['Write', 'Edit', 'Delete']);
        expect(paths(ops)).toEqual(['/repo/sub/added.txt', '/repo/sub/changed.ts', '/repo/sub/dropped.md']);
    });

    it('resolves a RELATIVE path against cwd and leaves an ABSOLUTE one alone', () => {
        const ops = parser.parse('*** Begin Patch\n*** Delete File: rel.txt\n*** Delete File: /other/abs.txt\n*** End Patch', CWD);
        expect(paths(ops)).toEqual(['/repo/sub/rel.txt', '/other/abs.txt']);
    });

    // FAIL CLOSED. Each of these must THROW so the hook denies — never return a partial reading that
    // would let the unparsed half of the patch through unjudged.
    it.each([
        ['no Begin Patch', '*** Add File: a.txt\n+x\n*** End Patch'],
        ['no End Patch', '*** Begin Patch\n*** Add File: a.txt\n+x'],
        ['a unified-diff hunk header', '*** Begin Patch\n*** Update File: a.ts\n@@ -1,3 +1,4 @@\n-a\n+b\n*** End Patch'],
        ['a hunk line with no leading marker', '*** Begin Patch\n*** Update File: a.ts\n@@\nbare\n*** End Patch'],
        ['an Update with no hunk', '*** Begin Patch\n*** Update File: a.ts\n*** End Patch'],
        ['an Add body line that is not a + line', '*** Begin Patch\n*** Add File: a.txt\nnope\n*** End Patch'],
        ['a stray line outside any file section', '*** Begin Patch\nstray\n*** End Patch'],
        ['an unknown directive', '*** Begin Patch\n*** Rename File: a.txt\n*** End Patch'],
        ['an empty path', '*** Begin Patch\n*** Delete File:   \n*** End Patch'],
        ['an envelope naming no files', '*** Begin Patch\n*** End Patch'],
    ])('DENIES a malformed envelope: %s', (_name: string, patch: string) => {
        expect(() => parser.parse(patch, CWD)).toThrow(InformAiError);
    });

    it('names the offending hunk header in the deny reason', () => {
        expect(() => parser.parse('*** Begin Patch\n*** Update File: a.ts\n@@ -1,3 +1,4 @@\n-a\n*** End Patch', CWD))
            .toThrow(/@@ -1,3 \+1,4 @@/);
    });
});
