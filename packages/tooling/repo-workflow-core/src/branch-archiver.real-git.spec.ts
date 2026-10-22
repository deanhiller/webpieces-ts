import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { BranchArchiver } from './branch-archiver';

/**
 * REAL git, not a fake — the few contract tests for the archive (#1381). The entire claim of Part 1 is
 * that a tag preserves the branch's objects EXACTLY — commit boundaries, messages, authorship,
 * parentage — where a patch would not, and that a tag is invisible to `git branch`. Those claims are
 * about git's behaviour, so faking git here would test nothing at all. Everything the archiver DECIDES
 * (naming, collisions, idempotence, failure reporting) is held by `branch-archiver.spec.ts` against
 * scripted git.
 */

const archiver = new BranchArchiver();
let repo = '';

function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(file: string, body: string, message: string): void {
    fs.writeFileSync(path.join(repo, file), body);
    git('add', file);
    git('commit', '-m', message);
}

beforeEach(() => {
    repo = specTempDirs.make('wp-archive-');
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    // Point hooks at an empty dir: a developer's GLOBAL core.hooksPath (this repo ships one) would
    // otherwise fire on every commit in the throwaway repo — slow, noisy, and not what is under test.
    git('config', 'core.hooksPath', path.join(repo, '.no-hooks'));
    commit('README.md', 'hello\n', 'initial');
});

afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('archive tag round trip — the whole premise of Part 1', () => {
    it('tag the tip, delete the branch, restore from the tag: identical tip SHA', async () => {
        git('checkout', '-b', 'dean/webpieces-0-3-322');
        commit('a.ts', 'const a = 1;\n', 'add a');
        commit('b.ts', 'const b = 2;\n', 'add b');
        const before = git('rev-parse', 'dean/webpieces-0-3-322');

        const result = await archiver.archive(repo, 'dean/webpieces-0-3-322');
        expect(result.ok).toBe(true);
        expect(result.sha).toBe(before);

        git('checkout', 'main');
        git('branch', '-D', 'dean/webpieces-0-3-322');
        expect(git('branch', '--list', 'dean/webpieces-0-3-322')).toBe('');

        // The literal command the tooling prints to a human.
        expect(archiver.restoreCommand('dean/webpieces-0-3-322', result.tag))
            .toBe(`git checkout -b dean/webpieces-0-3-322 ${result.tag}`);
        git('checkout', '-b', 'dean/webpieces-0-3-322', result.tag);

        expect(git('rev-parse', 'dean/webpieces-0-3-322')).toBe(before);
    });

    // A patch would flatten these; a tag does not. This is the concrete difference the design argued.
    it('restores the full commit history — boundaries, messages and authorship intact', async () => {
        git('checkout', '-b', 'feature/x');
        commit('a.ts', 'a\n', 'first commit');
        commit('b.ts', 'b\n', 'second commit');
        const log = git('log', '--format=%H %an %s', 'main..feature/x');

        const result = await archiver.archive(repo, 'feature/x');
        git('checkout', 'main');
        git('branch', '-D', 'feature/x');
        git('checkout', '-b', 'feature/x', result.tag);

        expect(git('log', '--format=%H %an %s', 'main..feature/x')).toBe(log);
        expect(log.split('\n').length).toBe(2);
    });

});

describe('archive tag naming and collision safety', () => {
    // The branch-cap argument: a tag is invisible to `git branch`, so it does not count toward
    // maxLocalBranches and cannot be accidentally committed onto.
    it('an archived-and-deleted branch no longer appears in git branch', async () => {
        git('checkout', '-b', 'dean/foo');
        commit('a.ts', 'a\n', 'a');
        const result = await archiver.archive(repo, 'dean/foo');
        git('checkout', 'main');
        git('branch', '-D', 'dean/foo');

        expect(git('branch', '--format=%(refname:short)').split('\n')).toEqual(['main']);
        expect(await archiver.listArchiveTags(repo)).toContain(result.tag);
    });
});
