import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    BranchCreationGuardConfig,
    DeletableWorktree,
    MergedBranchesService,
    WorktreeService,
} from '@webpieces/rules-config';

import type { BashContext } from '../types';
import { BranchCreationGuardRule } from './branch-creation-guard';

/**
 * The cap against REAL git — no mocked child_process.
 *
 * The unit specs prove the decisions; this proves the two things a mock structurally cannot: that we
 * parse what `git worktree list --porcelain` actually emits, and that the reap command we hand the
 * agent actually RUNS. The command's ordering (prune → remove → branch -D) is the whole point — git
 * refuses to delete a branch a worktree still holds, and since the delete is one multi-name command, a
 * single held branch takes the entire reap down with it. That failure only shows up against real git.
 */

let root = '';
let repo = '';

function git(args: string, cwd: string = repo): string {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

function ctx(command: string): BashContext {
    return { command, workspaceRoot: repo, options: {} } as BashContext;
}

const worktrees = new WorktreeService();
const merged = new MergedBranchesService(worktrees);

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-worktree-cap-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);

    execSync('git init -q -b main', { cwd: repo });
    // The repo's own commit hooks would otherwise fire inside this throwaway repo.
    git('config core.hooksPath /dev/null');
    git('config user.email t@t.co');
    git('config user.name tester');
    fs.writeFileSync(path.join(repo, 'f.txt'), 'hello\n');
    git('add -A');
    git('commit -qm init');
    // A local origin/main, so `origin/main..<branch>` resolves exactly as it does in a real clone.
    git('update-ref refs/remotes/origin/main HEAD');

    // Six worktrees. feat1..feat3 have no commits of their own (dead — identical to origin/main);
    // feat4..feat6 carry real work and must be spared.
    for (let i = 1; i <= 6; i++) {
        const dir = path.join(root, `wt${String(i)}`);
        git(`worktree add -q ${dir} -b feat${String(i)} origin/main`);
        if (i >= 4) {
            fs.writeFileSync(path.join(dir, `w${String(i)}.txt`), 'work\n');
            git('add -A', dir);
            git(`commit -qm w${String(i)}`, dir);
        }
    }

    // What the detached refresher does. `gh` fails here (no GitHub remote) — the fail-soft path, so the
    // only branches provable dead are the zero-commit ones.
    merged.writeMergedBranches(repo, merged.computeMergedBranches(repo));
});

afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
});

describe('branch-creation-guard against real git', () => {
    it('never proposes deleting a branch a worktree still holds', () => {
        const cache = merged.readMergedBranches(repo);

        // All six branches are worktree-held, so `git branch -D` must be offered NONE of them — even the
        // three that are provably dead. They get reaped by removing their worktree instead.
        expect(cache?.deletable.length).toBe(0);

        const dead = (cache?.worktrees ?? []).filter((tree: DeletableWorktree): boolean => tree.deletable);
        expect(dead.map((tree: DeletableWorktree): string => tree.branch).sort()).toEqual(['feat1', 'feat2', 'feat3']);
    });

    it('blocks the 6th worktree, and the reap command it emits actually runs clean', () => {
        expect(worktrees.linkedWorktrees(repo).length).toBe(6);

        const cfg = new BranchCreationGuardConfig();
        cfg.mode = 'ON_NO_SUBBRANCHES';
        const rule = new BranchCreationGuardRule(cfg);

        const add = `git worktree add ${path.join(root, 'wt7')} -b dean/next origin/main`;
        const violations = rule.check(ctx(add));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('6 linked worktrees');
        expect(violations[0].message).toContain('3 of them are dead');

        // Pull the command back out of the hint exactly as an agent would read it, and RUN it.
        const reap = rule.fixHint.fixOptions[0].text;
        const command = reap.slice(reap.indexOf('git worktree prune'));
        expect(command).toContain('git branch -D feat1 feat2 feat3');

        execSync(command, { cwd: repo, encoding: 'utf8' });

        expect(worktrees.linkedWorktrees(repo).length).toBe(3);
        expect(merged.localBranches(repo).sort()).toEqual(['feat4', 'feat5', 'feat6']);

        // Under the cap now, so the very command that was blocked must go through.
        expect(rule.check(ctx(add)).length).toBe(0);
    });
});
