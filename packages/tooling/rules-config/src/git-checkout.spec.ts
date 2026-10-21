import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { DETACHED_HEAD, GitCheckout, InformAiError } from '@webpieces/tooling-common';

/**
 * GitCheckout is the ONE answer to "where is this checkout and what is checked out in it" (#1355).
 * These are the four tree shapes the guards must keep judging exactly as before — primary clone, linked
 * worktree, detached HEAD, a directory outside any repository — plus the unborn branch and the inside-
 * `.git` corner, against REAL repositories (git's own answers are the thing under test).
 */

let scratch = '';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function makeRepo(name: string, commit: boolean): string {
    const repo = path.join(scratch, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.co');
    git(repo, 'config', 'user.name', 'tester');
    git(repo, 'config', 'core.hooksPath', '/dev/null');
    if (commit) git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    return repo;
}

/** Logs every `git` exec (the same shim the guard-hook budget spec counts with) — there must be none. */
class GitExecLog {
    private readonly bin: string;
    private readonly log: string;
    private saved: string | undefined;

    constructor() {
        this.bin = path.join(scratch, 'shim-bin');
        this.log = path.join(scratch, 'git.log');
        fs.mkdirSync(this.bin, { recursive: true });
        const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        fs.writeFileSync(path.join(this.bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${this.log}'\nexec '${real}' "$@"\n`);
        fs.chmodSync(path.join(this.bin, 'git'), 0o755);
    }

    count(action: () => void): number {
        fs.writeFileSync(this.log, '');
        this.saved = process.env['PATH'];
        process.env['PATH'] = `${this.bin}${path.delimiter}${this.saved ?? ''}`;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the PATH must be restored whatever the action does; a throw still propagates
        try {
            action();
        } finally {
            process.env['PATH'] = this.saved;
        }
        return fs.readFileSync(this.log, 'utf8').split('\n').filter((line: string) => line !== '').length;
    }
}

beforeAll(() => {
    scratch = specTempDirs.makeReal('wp-git-checkout-');
});

describe('GitCheckout — the four tree shapes', () => {
    it('answers the primary clone: its .git as both dirs, its root, and its branch', () => {
        const repo = makeRepo('primary', true);
        const facts = new GitCheckout().facts(repo);
        expect(facts.gitDir).toBe(path.join(repo, '.git'));
        expect(facts.commonDir).toBe(path.join(repo, '.git'));
        expect(facts.toplevel).toBe(repo);
        expect(facts.isLinkedWorktree).toBe(false);
        expect(new GitCheckout().branch(repo)).toBe('main');
    });

    it('answers a linked worktree from ITS OWN git dir and HEAD, with the primary as common dir', () => {
        const repo = makeRepo('with-worktree', true);
        const linked = path.join(scratch, 'linked');
        git(repo, 'worktree', 'add', '-q', '-b', 'dean/linked', linked);
        const facts = new GitCheckout().facts(linked);
        expect(facts.gitDir).toBe(path.join(repo, '.git', 'worktrees', 'linked'));
        expect(facts.commonDir).toBe(path.join(repo, '.git'));
        expect(facts.toplevel).toBe(linked);
        expect(facts.isLinkedWorktree).toBe(true);
        expect(new GitCheckout().branch(linked)).toBe('dean/linked');
        expect(new GitCheckout().branch(repo)).toBe('main');
    });

    it('answers DETACHED_HEAD on a detached HEAD, as `--abbrev-ref` printed', () => {
        const repo = makeRepo('detached', true);
        git(repo, 'checkout', '-q', '--detach');
        expect(new GitCheckout().branch(repo)).toBe(DETACHED_HEAD);
        expect(new GitCheckout().branch(repo)).toBe(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));
    });

    it('answers null everywhere outside any repository, and requireBranch names the directory', () => {
        const outside = path.join(scratch, 'not-a-repo');
        fs.mkdirSync(outside);
        const facts = new GitCheckout().facts(outside);
        expect(facts.gitDir).toBeNull();
        expect(facts.commonDir).toBeNull();
        expect(facts.toplevel).toBeNull();
        expect(new GitCheckout().branch(outside)).toBeNull();
        expect(() => new GitCheckout().requireBranch(outside)).toThrow(InformAiError);
        expect(() => new GitCheckout().requireBranch(outside)).toThrow(outside);
    });
});

describe('GitCheckout — corners', () => {
    it('names an UNBORN branch, as `git branch --show-current` does', () => {
        const repo = makeRepo('unborn', false);
        expect(new GitCheckout().branch(repo)).toBe('main');
    });

    it('keeps the two git dirs inside `.git` itself, where git has no work tree to name', () => {
        const repo = makeRepo('inside-dot-git', true);
        const facts = new GitCheckout().facts(path.join(repo, '.git'));
        expect(facts.gitDir).toBe(path.join(repo, '.git'));
        expect(facts.commonDir).toBe(path.join(repo, '.git'));
        expect(facts.toplevel).toBeNull();
    });

    it('reads the branch FRESH, so a checkout later in the same process is seen', () => {
        const repo = makeRepo('switching', true);
        const checkout = new GitCheckout();
        expect(checkout.branch(repo)).toBe('main');
        git(repo, 'checkout', '-q', '-b', 'dean/next');
        expect(checkout.branch(repo)).toBe('dean/next');
    });
});

describe('GitCheckout — cost (#1355)', () => {
    it('spends NO git process — every answer is a filesystem read, against git\'s own answers', () => {
        const repo = makeRepo('cost', true);
        const sub = path.join(repo, 'a', 'b');
        fs.mkdirSync(sub, { recursive: true });
        const execs = new GitExecLog();
        const spawned = execs.count(() => {
            expect(new GitCheckout().facts(sub).toplevel).toBe(repo);
            expect(new GitCheckout().facts(repo).gitDir).toBe(path.join(repo, '.git'));
            expect(new GitCheckout().branch(sub)).toBe('main');
            expect(new GitCheckout().branch(repo)).toBe('main');
            expect(new GitCheckout().isLinkedWorktree(repo)).toBe(false);
        });
        expect(spawned).toBe(0);
    });

    it('matches what git itself prints for a subdirectory of a linked worktree', () => {
        const repo = makeRepo('cost-linked', true);
        const linked = path.join(scratch, 'cost-linked-wt');
        git(repo, 'worktree', 'add', '-q', '-b', 'dean/cost', linked);
        const sub = path.join(linked, 'deep', 'er');
        fs.mkdirSync(sub, { recursive: true });
        const printed = git(sub, 'rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel', '--abbrev-ref', 'HEAD')
            .split('\n')
            .map((line: string) => path.resolve(sub, line));
        const facts = new GitCheckout().facts(sub);
        expect([facts.gitDir, facts.commonDir, facts.toplevel]).toEqual(printed.slice(0, 3));
        expect(new GitCheckout().branch(sub)).toBe('dean/cost');
    });

    it('answers "not a repository" for a .git pointer to nowhere, as git does', () => {
        const dir = path.join(scratch, 'dangling');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /no/such/dir\n');
        expect(new GitCheckout().facts(dir).gitDir).toBeNull();
        expect(new GitCheckout().branch(dir)).toBeNull();
    });
});
