import { describe, it, expect } from 'vitest';
import { GitStatusEntry, GitStatusParser } from './git-status';

const parser = new GitStatusParser();
const one = (line: string): GitStatusEntry => {
    const entries = parser.parse(line);
    expect(entries.length).toBe(1);
    return entries[0];
};

describe('the staged/unstaged inversion this parser exists to prevent', () => {
    it('" M path" is UNSTAGED (the leading space IS the empty index column)', () => {
        const entry = one(' M src/a.ts');
        expect(entry.path).toBe('src/a.ts');
        expect(entry.indexStatus).toBe(' ');
        expect(entry.worktreeStatus).toBe('M');
        expect(entry.isStaged()).toBe(false);
        expect(entry.isUnstaged()).toBe(true);
        expect(entry.isCommittedOrStaged()).toBe(false);
    });

    it('"M  path" is STAGED — the same two characters, the other way round', () => {
        const entry = one('M  src/a.ts');
        expect(entry.path).toBe('src/a.ts');
        expect(entry.isStaged()).toBe(true);
        expect(entry.isUnstaged()).toBe(false);
        expect(entry.isCommittedOrStaged()).toBe(true);
    });

    it('a trimmed " M path" would parse as the exact inverse — which is why nothing trims', () => {
        // Feeding the parser the trimmed text reproduces the original bug, on purpose, so the
        // difference between the two is asserted rather than described in a comment.
        expect(one(' M src/a.ts'.trim()).isStaged()).toBe(true);
    });

    it('"MM path" is staged AND unstaged at once', () => {
        const entry = one('MM src/a.ts');
        expect(entry.isStaged()).toBe(true);
        expect(entry.isUnstaged()).toBe(true);
        expect(entry.isCommittedOrStaged()).toBe(false);
    });

    it('"?? path" is untracked: not staged, and never "committed or staged"', () => {
        const entry = one('?? build/out.html');
        expect(entry.isUntracked()).toBe(true);
        expect(entry.isStaged()).toBe(false);
        expect(entry.isUnstaged()).toBe(true);
        expect(entry.isCommittedOrStaged()).toBe(false);
    });

    it('"!! path" (--ignored) is neither staged nor unstaged', () => {
        const entry = one('!! node_modules/x.js');
        expect(entry.isIgnored()).toBe(true);
        expect(entry.isStaged()).toBe(false);
        expect(entry.isUnstaged()).toBe(false);
    });

    it('"A  path" (newly added) and "D  path" (staged delete) are staged', () => {
        expect(one('A  new.ts').isStaged()).toBe(true);
        expect(one('D  gone.ts').isStaged()).toBe(true);
        expect(one(' D gone.ts').isStaged()).toBe(false);
    });
});

describe('paths', () => {
    it('a rename is attributed to the NEW name, keeping the old one', () => {
        const entry = one('R  old/name.ts -> new/name.ts');
        expect(entry.path).toBe('new/name.ts');
        expect(entry.renamedFrom).toBe('old/name.ts');
        expect(entry.isStaged()).toBe(true);
    });

    it('a QUOTED path with spaces is unquoted', () => {
        expect(one(' M "a file/with spaces.txt"').path).toBe('a file/with spaces.txt');
    });

    it('a rename of quoted paths with spaces splits on the arrow OUTSIDE the quotes', () => {
        const entry = one('R  "old dir/a b.txt" -> "new dir/c d.txt"');
        expect(entry.renamedFrom).toBe('old dir/a b.txt');
        expect(entry.path).toBe('new dir/c d.txt');
    });

    it('a NON-rename entry whose path contains " -> " is not mis-split (only R/C carry the arrow)', () => {
        expect(one('?? weird -> name.txt').path).toBe('weird -> name.txt');
        expect(one('?? weird -> name.txt').renamedFrom).toBe('');
    });

    it('a copy (C) is treated like a rename', () => {
        expect(one('C  src.ts -> copy.ts').path).toBe('copy.ts');
    });

    it('octal escapes are decoded as BYTES, so multi-byte UTF-8 survives', () => {
        // git renders "uni-é.txt" as "uni-\303\251.txt" — two escapes forming ONE character.
        expect(one(' M "uni-\\303\\251.txt"').path).toBe('uni-é.txt');
    });

    it('decodes an escaped quote and backslash', () => {
        expect(one(' M "say \\"hi\\".txt"').path).toBe('say "hi".txt');
        expect(one(' M "back\\\\slash.txt"').path).toBe('back\\slash.txt');
    });

    it('a path is NOT trimmed — git reports exactly what is on disk', () => {
        expect(one(' M "trailing space .txt"').path).toBe('trailing space .txt');
    });
});

describe('multi-line parsing', () => {
    it('parses every line, including the FIRST — the one a whole-output trim() corrupted', () => {
        const entries = parser.parse(' M first.ts\nM  second.ts\n?? third.ts\n');
        expect(entries.map((e: GitStatusEntry): string => e.path)).toEqual(['first.ts', 'second.ts', 'third.ts']);
        expect(entries[0].isStaged()).toBe(false);
        expect(entries[1].isStaged()).toBe(true);
    });

    it('empty text, blank lines and truncated lines yield nothing', () => {
        expect(parser.parse('')).toEqual([]);
        expect(parser.parse('\n\n')).toEqual([]);
        expect(parser.parse(' M ')).toEqual([]);
    });

    it('tolerates CRLF line endings', () => {
        const entries = parser.parse(' M first.ts\r\nM  second.ts\r\n');
        expect(entries.map((e: GitStatusEntry): string => e.path)).toEqual(['first.ts', 'second.ts']);
    });
});
