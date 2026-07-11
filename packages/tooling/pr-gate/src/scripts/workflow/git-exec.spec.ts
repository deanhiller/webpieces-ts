import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { RepoRootFinder } from '@webpieces/rules-config';
import { GitExec } from './git-exec';

const git = new GitExec(new RepoRootFinder());
const uncommittedFiles = (d: string): string => git.uncommittedFiles(d);
const untrackedFiles = (d: string): string => git.untrackedFiles(d);
const assertCleanTree = (d: string): void => git.assertCleanTree(d);
const assertNoUntracked = (d: string): void => git.assertNoUntracked(d);

// Build a throwaway git repo with one committed tracked file and a .gitignore. core.hooksPath=/dev/null
// so the ambient webpieces hooks never fire on these scaffolding commits.
function initRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-gitexec-'));
    const run = (args: string): void => { execSync(`git ${args}`, { cwd: dir, stdio: 'ignore' }); };
    run('init -q');
    run('config core.hooksPath /dev/null');
    run('config user.email test@example.com');
    run('config user.name test');
    run('config commit.gpgsign false');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n*.log\n');
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello\n');
    run('add -A');
    run('commit -q -m initial');
    return dir;
}

describe('uncommittedFiles / untrackedFiles', () => {
    it('a freshly-committed tree is clean (both empty)', () => {
        const dir = initRepo();
        expect(uncommittedFiles(dir)).toBe('');
        expect(untrackedFiles(dir)).toBe('');
    });

    it('a modified tracked file shows in uncommittedFiles but not untrackedFiles', () => {
        const dir = initRepo();
        fs.writeFileSync(path.join(dir, 'tracked.txt'), 'changed\n');
        expect(uncommittedFiles(dir)).toContain('tracked.txt');
        expect(untrackedFiles(dir)).toBe('');
    });

    it('an untracked file shows in BOTH (this is the case the old diff-index check missed)', () => {
        const dir = initRepo();
        fs.writeFileSync(path.join(dir, 'stray.txt'), 'junk\n');
        expect(uncommittedFiles(dir)).toContain('stray.txt');
        expect(untrackedFiles(dir)).toContain('stray.txt');
    });

    it('finds an untracked file in a nested subdir (run from repo root, not cwd subtree)', () => {
        const dir = initRepo();
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'a', 'b', 'deep.txt'), 'x\n');
        expect(untrackedFiles(dir)).toContain(path.join('a', 'b', 'deep.txt'));
    });

    it('gitignored paths are excluded from both', () => {
        const dir = initRepo();
        fs.writeFileSync(path.join(dir, 'debug.log'), 'noise\n');
        fs.mkdirSync(path.join(dir, 'ignored'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'ignored', 'x.txt'), 'noise\n');
        expect(uncommittedFiles(dir)).toBe('');
        expect(untrackedFiles(dir)).toBe('');
    });
});

describe('assertCleanTree / assertNoUntracked', () => {
    it('return normally (do not exit) on a clean tree', () => {
        const dir = initRepo();
        expect(() => assertCleanTree(dir)).not.toThrow();
        expect(() => assertNoUntracked(dir)).not.toThrow();
    });
});
