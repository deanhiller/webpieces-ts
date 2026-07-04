import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getChangedFiles } from './diff-scope';

function git(root: string, cmd: string): string {
    // core.hooksPath=/dev/null: keep any machine-global git hooks out of the throwaway test repo.
    return execSync(`git -c core.hooksPath=/dev/null ${cmd}`, {
        cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
}

function writeFile(root: string, relPath: string, content: string): void {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
}

/**
 * Reproduces BUG-validate-ts-in-src-false-positive: `git diff --name-only` lists the OLD side of
 * deletes and renames, so diff-scoped rules were validating paths that no longer exist (e.g.
 * flagging `libraries/apis/src/.../AuthApi.ts` as "outside any Nx project" after the whole
 * directory was `git mv`ed elsewhere). getChangedFiles must never return a path that is absent
 * from the working tree.
 */
describe('getChangedFiles ghost paths (deleted/renamed old paths)', () => {
    let root: string;
    let base: string;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-scope-')));
        git(root, 'init -q -b main');
        git(root, 'config user.email test@test.com');
        git(root, 'config user.name test');
        writeFile(root, 'libraries/foo/src/Keep.ts', 'export const keep = 1;\n');
        writeFile(root, 'libraries/foo/src/Moved.ts', 'export const moved = 1;\n');
        writeFile(root, 'libraries/foo/src/Deleted.ts', 'export const deleted = 1;\n');
        git(root, 'add -A');
        git(root, 'commit -q -m base');
        base = git(root, 'rev-parse HEAD');
    });

    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('excludes deleted files and reports renames only at their new path', () => {
        fs.mkdirSync(path.join(root, 'libraries/nested/foo/src'), { recursive: true });
        git(root, 'mv libraries/foo/src/Moved.ts libraries/nested/foo/src/Moved.ts');
        git(root, 'rm -q libraries/foo/src/Deleted.ts');
        git(root, 'commit -q -m reorg');

        const changed = getChangedFiles(root, base);

        expect(changed).toContain('libraries/nested/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Deleted.ts');
    });

    it('excludes an uncommitted working-tree deletion', () => {
        fs.rmSync(path.join(root, 'libraries/foo/src/Deleted.ts'));

        const changed = getChangedFiles(root, base);

        expect(changed).not.toContain('libraries/foo/src/Deleted.ts');
    });

    it('still reports modified and untracked files', () => {
        writeFile(root, 'libraries/foo/src/Keep.ts', 'export const keep = 2;\n');
        writeFile(root, 'libraries/foo/src/Untracked.ts', 'export const untracked = 1;\n');

        const changed = getChangedFiles(root, base);

        expect(changed).toContain('libraries/foo/src/Keep.ts');
        expect(changed).toContain('libraries/foo/src/Untracked.ts');
    });

    it('excludes deletions in a two-ref (base..head) diff', () => {
        fs.mkdirSync(path.join(root, 'libraries/nested/foo/src'), { recursive: true });
        git(root, 'mv libraries/foo/src/Moved.ts libraries/nested/foo/src/Moved.ts');
        git(root, 'rm -q libraries/foo/src/Deleted.ts');
        git(root, 'commit -q -m reorg');
        const head = git(root, 'rev-parse HEAD');

        const changed = getChangedFiles(root, base, head);

        expect(changed).toContain('libraries/nested/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Moved.ts');
        expect(changed).not.toContain('libraries/foo/src/Deleted.ts');
    });
});
