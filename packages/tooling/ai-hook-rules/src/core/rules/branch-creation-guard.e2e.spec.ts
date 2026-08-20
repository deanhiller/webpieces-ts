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

import { BashContext } from '../types';
import { BranchCreationGuardRule } from './branch-creation-guard';

/**
 * The cap against REAL git — no mocked child_process.
 *
 * The unit specs prove the decisions; this proves what a mock structurally cannot: that we parse what
 * `git worktree list --porcelain` actually emits, over worktrees made the way the docs tell you to make
 * them (`git worktree add -b <name> origin/main`).
 *
 * It used to assert that the reap ONE-LINER the guard printed ran clean. It did run clean — that was
 * the problem. Three of the six worktrees below are exactly what an agent's freshly created worktree
 * looks like (no commits yet, no PR), and the guard called them dead and offered to delete them, which
 * on 2026-07-30 it did to three worktrees with live agents in them. So the assertion is inverted: over
 * real git, with no merged PR provable, NOTHING may be offered for deletion.
 */

/**
 * SLOW BY NATURE: `git init`, a commit, then six `git worktree add` calls in `beforeAll`, plus the
 * `git worktree list --porcelain` reads under test. 46s standalone on an IDLE machine — within 10% of the
 * 45s global before anything else runs, and it is the HOOK that runs out, not any `it()`. It gets the tooling budget
 * from vitest.setup.mts, which grants that to every `packages/tooling/**` suite.
 */

let root = '';
let repo = '';

function git(args: string, cwd: string = repo): string {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim();
}

function ctx(command: string): BashContext {
    return new BashContext(command, repo);
}

const worktrees = new WorktreeService();
const merged = new MergedBranchesService(worktrees);

/**
 * NO explicit timeout here, deliberately — it takes the budget that vitest.setup.mts grants every
 * `packages/tooling/**` spec.
 *
 * This hook does REAL work: `git init`, a commit, SIX `git worktree add` calls that each check out a
 * working copy, then the refresher's own `gh` probes. ~2s idle, but wall-clock scales with whatever else
 * is shelling out to git at the same time, and `nx affected` runs several projects' suites concurrently.
 * The hook is not slow because it is wrong; six worktrees cost what six worktrees cost.
 *
 * It used to carry `}, 60_000)`. That was WORSE than no annotation once the class-wide budget existed: an
 * explicit third argument OVERRIDES `vi.setConfig` from a setup file, so the one hook most in need of the
 * budget was the only one silently capped at 60s — against a 46s idle measurement, i.e. 14s of margin under
 * exactly the load the budget exists to survive. Do not re-add a number here; raise it in
 * vitest.setup.mts for the whole class or not at all.
 */
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

    // Six worktrees. feat1..feat3 have no commits of their own — the state EVERY worktree is in from
    // `git worktree add -b … origin/main` until its first commit, i.e. while an agent is working in it.
    // feat4..feat6 carry real work. With no merged PR provable, all six are LIVE.
    for (let i = 1; i <= 6; i++) {
        const dir = path.join(root, `wt${String(i)}`);
        git(`worktree add -q ${dir} -b feat${String(i)} origin/main`);
        if (i >= 4) {
            fs.writeFileSync(path.join(dir, `w${String(i)}.txt`), 'work\n');
            git('add -A', dir);
            git(`commit -qm w${String(i)}`, dir);
        }
    }

    // What the detached refresher does. `gh` fails here (no GitHub remote) — the fail-soft path, so
    // NOTHING is provably merged, and therefore nothing is reapable.
    merged.writeMergedBranches(repo, merged.computeMergedBranches(repo));
});

afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
});

describe('branch-creation-guard against real git', () => {
    it('records a verdict for every worktree, and calls none of them dead without a merged PR', () => {
        const cache = merged.readMergedBranches(repo);

        // Every branch is worktree-held, so none is offered for `git branch -D` regardless of verdict.
        expect(cache?.deletable.length).toBe(0);

        // Part 2 of the ticket: the refresher records status for EVERY worktree, not just interesting ones.
        expect((cache?.worktrees ?? []).length).toBe(6);

        // Part 1: no merged PR anywhere, so nothing is reapable — INCLUDING feat1..feat3, which hold no
        // commits of their own. That is a worktree in active use, not a corpse.
        const dead = (cache?.worktrees ?? []).filter((tree: DeletableWorktree): boolean => tree.deletable);
        expect(dead).toEqual([]);
    });

    it('blocks the 6th worktree and prints NO command that deletes anything', () => {
        expect(worktrees.linkedWorktrees(repo).length).toBe(6);

        const cfg = new BranchCreationGuardConfig();
        cfg.mode = 'ON_NO_SUBBRANCHES';
        const rule = new BranchCreationGuardRule(cfg);

        const add = `git worktree add ${path.join(root, 'wt7')} -b dean/next origin/main`;
        const violations = rule.check(ctx(add));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('6 linked worktrees');
        expect(violations[0].message).toContain('pnpm wp-cleanup');

        // The whole remedy, read exactly as an agent reads it. Not one destructive git command in it.
        const hint = rule.fixHint;
        const flat = [hint.mainMessage, hint.subMessage, ...hint.fixOptions.map((o: { text: string }): string => o.text)]
            .join('\n');
        expect(flat).not.toContain('git worktree remove');
        expect(flat).not.toContain('git worktree prune');
        expect(flat).not.toContain('git branch -D');
        expect(flat).not.toContain('no work can be lost');
        expect(flat).toContain('pnpm wp-cleanup');

        // And the six live worktrees are still there — nothing about being at the cap removed anything.
        expect(worktrees.linkedWorktrees(repo).length).toBe(6);
    });

});

describe('branch-creation-guard against real git — the merged half', () => {
    /**
     * The other half of "live unless merged": once a branch IS provably merged, its worktree becomes
     * reapable on that evidence alone. `gh` cannot run here, so the merged verdict is injected the same
     * way the refresher would have written it, and the guard is asked what it does with it.
     */
    it('does offer a worktree whose PR is merged — but still only via wp-cleanup', () => {
        const cache = merged.computeMergedBranches(repo);
        // git reports its own canonicalised path (on macOS /var/… resolves to /private/var/…), so take
        // the path from git rather than reconstructing it — reconcile() matches on exactly this string.
        const wt1 = cache.worktrees[0].path;
        cache.worktrees = cache.worktrees.map((tree: DeletableWorktree): DeletableWorktree =>
            tree.path === wt1
                ? new DeletableWorktree(tree.path, tree.branch, 'PR #514 merged', 514, true, 'merged-pr')
                : tree);
        merged.writeMergedBranches(repo, cache);

        const cfg = new BranchCreationGuardConfig();
        cfg.mode = 'ON_NO_SUBBRANCHES';
        const rule = new BranchCreationGuardRule(cfg);
        const violations = rule.check(ctx(`git worktree add ${path.join(root, 'wt7')} -b dean/next origin/main`));

        expect(violations.length).toBe(1);
        expect(violations[0].message).toContain('pnpm wp-cleanup');

        // The dead worktree is NOT named here — the remedy is the command, and wp-cleanup names what
        // it removes from fresh verdicts as it removes it.
        const flat = rule.fixHint.fixOptions.map((o: { text: string }): string => o.text).join('\n');
        expect(flat).not.toContain(wt1);
        expect(flat).toContain('pnpm wp-cleanup');
        expect(flat).not.toContain('git worktree remove');
    });
});
