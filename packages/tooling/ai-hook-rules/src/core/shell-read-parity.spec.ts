import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ShellReadParity } from './shell-read-parity';

const parity = new ShellReadParity();
let root = '';
let fileA = '';
let fileB = '';

beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-read-parity-')));
    fs.mkdirSync(path.join(root, 'src'));
    fileA = path.join(root, 'src', 'a.ts');
    fileB = path.join(root, 'src', 'b.ts');
    fs.writeFileSync(fileA, 'a\n');
    fs.writeFileSync(fileB, 'b\n');
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('ShellReadParity — the READ corpus', () => {
    it.each([
        'cat src/a.ts',
        'head -50 src/a.ts',
        'head -n 50 src/a.ts',
        'tail -20 src/a.ts',
        'less src/a.ts',
        'more src/a.ts',
        'bat src/a.ts',
        "sed -n '1,240p' src/a.ts",
        'sed -n 12p src/a.ts',
    ])('recognises %s as a read of the file', (command: string) => {
        expect(parity.readTargets(command, root, root)).toEqual([fileA]);
    });

    it('recognises a multi-file read and returns every path', () => {
        expect(parity.readTargets('cat src/a.ts src/b.ts', root, root)).toEqual([fileA, fileB]);
    });

    it('accepts a quoted path and an absolute path', () => {
        expect(parity.readTargets(`cat '${fileA}'`, root, root)).toEqual([fileA]);
    });
});

describe('ShellReadParity — the NOT-a-read corpus', () => {
    it.each([
        // More than one command: the second half is unjudged by a read verdict.
        ['a && chain', 'cat src/a.ts && rm src/b.ts'],
        ['a ; chain', 'cat src/a.ts ; rm src/b.ts'],
        ['a || chain', 'cat src/a.ts || true'],
        ['a pipe into a shell', 'cat src/a.ts | sh'],
        ['any pipe at all', 'cat src/a.ts | head -3'],
        ['a redirect out', 'cat > src/a.ts'],
        ['a redirect in', 'cat < src/a.ts'],
        ['a command substitution', 'cat $(ls src)'],
        ['a backtick substitution', 'cat `ls src`'],
        // Outside the tree, so not this repo's read.
        ['a file outside the tree', 'cat /etc/passwd'],
        // Not a file.
        ['a directory', 'cat src'],
        ['a path that does not exist', 'cat src/nope.ts'],
        // Not a pager.
        ['grep', 'grep -rn x src/a.ts'],
        ['an editor', 'vim src/a.ts'],
        // sed that is not a plain range print.
        ['sed without -n', 'sed 1,20p src/a.ts'],
        ['sed running a substitution', "sed -n 's/a/b/p' src/a.ts"],
        ['sed with no file operand', "sed -n '1,20p'"],
        // Nothing to read.
        ['a bare pager', 'cat'],
        ['an empty command', '   '],
        // One good file and one bad one is NOT a partial read — it is not a read.
        ['a mixed read', 'cat src/a.ts /etc/passwd'],
    ])('refuses %s', (_name: string, command: string) => {
        expect(parity.readTargets(command, root, root)).toEqual([]);
    });

    it('refuses a command with an unterminated quote', () => {
        expect(parity.readTargets("cat 'src/a.ts", root, root)).toEqual([]);
    });
});
