import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { RepoRootFinder } from '@webpieces/rules-config';
import { GitExec } from './git-exec';
import { GitStatusEntry, GitStatusParser } from './git-status';

const git = new GitExec(new RepoRootFinder(), new GitStatusParser());
const porcelainStatus = (d: string): string => git.porcelainStatus(d);
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

describe('porcelainStatus / untrackedFiles', () => {
    it('a freshly-committed tree is clean (both empty)', () => {
        const dir = initRepo();
        expect(porcelainStatus(dir)).toBe('');
        expect(untrackedFiles(dir)).toBe('');
    });

    it('a modified tracked file shows in porcelainStatus but not untrackedFiles', () => {
        const dir = initRepo();
        fs.writeFileSync(path.join(dir, 'tracked.txt'), 'changed\n');
        expect(porcelainStatus(dir)).toContain('tracked.txt');
        expect(untrackedFiles(dir)).toBe('');
    });

    it('an untracked file shows in BOTH (this is the case the old diff-index check missed)', () => {
        const dir = initRepo();
        fs.writeFileSync(path.join(dir, 'stray.txt'), 'junk\n');
        expect(porcelainStatus(dir)).toContain('stray.txt');
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
        expect(porcelainStatus(dir)).toBe('');
        expect(untrackedFiles(dir)).toBe('');
    });
});

describe('porcelainStatus / statusEntries keep the index column that trimming destroys', () => {
    // One repo, three states — `git init` + config + commit is 8 subprocesses, so this walks a single
    // repo through clean → unstaged → staged rather than building three.
    it('distinguishes unstaged (" M") from staged ("M "), end to end against real git', () => {
        const dir = initRepo();
        expect(git.porcelainStatus(dir)).toBe('');
        expect(git.statusEntries(dir)).toEqual([]);

        fs.writeFileSync(path.join(dir, 'tracked.txt'), 'changed\n');
        expect(git.porcelainStatus(dir)).toBe(' M tracked.txt');
        const unstaged: GitStatusEntry[] = git.statusEntries(dir);
        expect(unstaged.length).toBe(1);
        expect(unstaged[0].path).toBe('tracked.txt');
        expect(unstaged[0].isStaged()).toBe(false);
        expect(unstaged[0].isUnstaged()).toBe(true);
        // The trap the deleted uncommittedFiles() fell into: trim() would make this read as staged.
        expect(git.porcelainStatus(dir).trim()).toBe('M tracked.txt');

        execSync('git add tracked.txt', { cwd: dir, stdio: 'ignore' });
        expect(git.porcelainStatus(dir)).toBe('M  tracked.txt');
        const staged: GitStatusEntry[] = git.statusEntries(dir);
        expect(staged[0].isStaged()).toBe(true);
        expect(staged[0].isUnstaged()).toBe(false);
    });

    it('reports a quoted path with spaces unquoted, and a rename by its NEW name', () => {
        const dir = initRepo();
        fs.writeFileSync(path.join(dir, 'a file.txt'), 'x\n');
        execSync('git add -A && git commit -q -m spaces', { cwd: dir, stdio: 'ignore' });
        execSync('git mv "a file.txt" "b file.txt"', { cwd: dir, stdio: 'ignore' });
        const entries: GitStatusEntry[] = git.statusEntries(dir);
        expect(entries.length).toBe(1);
        expect(entries[0].path).toBe('b file.txt');
        expect(entries[0].renamedFrom).toBe('a file.txt');
        expect(entries[0].isStaged()).toBe(true);
    });
});

describe('assertCleanTree / assertNoUntracked', () => {
    it('return normally (do not exit) on a clean tree', () => {
        const dir = initRepo();
        expect(() => assertCleanTree(dir)).not.toThrow();
        expect(() => assertNoUntracked(dir)).not.toThrow();
    });
});
