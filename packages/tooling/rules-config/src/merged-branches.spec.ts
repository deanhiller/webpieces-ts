import { describe, it, expect, vi, beforeEach } from 'vitest';

// What the mocked `gh pr list --state merged` returns, and what `git for-each-ref` sees locally.
const world = vi.hoisted(() => ({
    mergedPrs: [] as { number: number; headRefName: string }[],
    // `gh pr list --state all` — every PR with its state, the DISPLAY-only lookup main added in #509.
    // Our `superseded` signal reads CLOSED entries off this same call rather than adding a third one.
    allPrs: [] as { number: number; headRefName: string; state: string }[],
    // Branch → what `git cherry origin/main <branch>` prints. A `- <sha>` line means an equivalent
    // change is ALREADY upstream; `+ <sha>` means it is not.
    cherry: {} as Record<string, string>,
    localBranches: [] as string[],
    currentBranch: 'main',
    ghOk: true,
    // Commits each branch has that origin/main does not. Anything absent is assumed to have work.
    commitsAhead: {} as Record<string, number>,
    // LINKED worktrees (the primary clone, at /repo on `currentBranch`, is synthesised below).
    worktrees: [] as { path: string; branch: string; extra?: string }[],
}));

vi.mock('child_process', () => ({
    spawnSync: (cmd: string, args: string[]): { status: number; stdout: string } => {
        if (cmd === 'gh') {
            if (!world.ghOk) return { status: 1, stdout: '' };
            const state = args[args.indexOf('--state') + 1];
            return { status: 0, stdout: JSON.stringify(state === 'all' ? world.allPrs : world.mergedPrs) };
        }
        if (cmd === 'git' && args[0] === 'rev-parse') {
            return { status: 0, stdout: `sha-${String(args[args.length - 1])}` };
        }
        if (cmd === 'git' && args[0] === 'cherry') {
            const listing = world.cherry[String(args[2])];
            if (listing === undefined) return { status: 1, stdout: '' };
            return { status: 0, stdout: listing };
        }
        if (cmd === 'git' && args[0] === 'for-each-ref') {
            return { status: 0, stdout: world.localBranches.join('\n') + '\n' };
        }
        if (cmd === 'git' && args[0] === 'worktree') {
            let out = `worktree /repo\nHEAD aaa\nbranch refs/heads/${world.currentBranch}\n`;
            for (const tree of world.worktrees) {
                out += `\nworktree ${tree.path}\nHEAD bbb\nbranch refs/heads/${tree.branch}\n`;
                if (tree.extra) out += `${tree.extra}\n`;
            }
            return { status: 0, stdout: out };
        }
        if (cmd === 'git' && args[0] === 'rev-list') {
            const branch = String(args[2]).replace('origin/main..', '');
            return { status: 0, stdout: String(world.commitsAhead[branch] ?? 1) };
        }
        return { status: 1, stdout: '' };
    },
}));

import {
    MergedBranchesService,
    DeletableBranch,
    CLASSIFICATION_MERGED_PR,
    CLASSIFICATION_BACKUP_OF_MERGED,
    CLASSIFICATION_NO_COMMITS,
    CLASSIFICATION_SUPERSEDED,
    CLASSIFICATION_CONTENT_IN_MAIN,
    CLASSIFICATION_NEVER_PROPOSED,
    CLASSIFICATION_PRUNABLE,
    CLASSIFICATION_LOCKED,
    CLASSIFICATION_CURRENT,
} from './merged-branches';

function names(list: DeletableBranch[]): string[] {
    return list.map((entry: DeletableBranch): string => entry.branch).sort();
}

const svc = new MergedBranchesService();

beforeEach(() => {
    world.mergedPrs = [];
    world.allPrs = [];
    world.cherry = {};
    world.localBranches = [];
    world.currentBranch = 'main';
    world.ghOk = true;
    world.commitsAhead = {};
    world.worktrees = [];
});

describe('MergedBranchesService.computeMergedBranches', () => {
    it('marks a branch deletable when its own PR is merged, and spares one with no PR', () => {
        world.mergedPrs = [{ number: 188, headRefName: 'dean/config-overhaul' }];
        world.localBranches = ['main', 'dean/config-overhaul', 'dean/still-working'];

        const cache = svc.computeMergedBranches('/repo');

        expect(names(cache.deletable)).toEqual(['dean/config-overhaul']);
        expect(cache.deletable[0].pr).toBe(188);
        expect(cache.deletable[0].reason).toContain('PR #188 merged');
        expect(names(cache.keep)).toEqual(['dean/still-working']);
    });

    /**
     * The squash-merge tool's backup branches (base → baseSquash / basewp2 / basePreMerge3) exist only
     * locally — GitHub has never seen their SHAs, so no PR will ever name them. They are reapable only
     * by stripping back to the base branch. Without this, the branch cap is unreachable: in the repo
     * that motivated this, 6 of 22 dead branches were backups.
     */
    it('reaps squash-merge backups once the branch they back up has merged', () => {
        world.mergedPrs = [{ number: 332, headRefName: 'dean/http-client' }];
        world.localBranches = [
            'main',
            'dean/http-client',
            'dean/http-clientPreMerge2',
            'dean/http-clientwp3',
            'dean/http-clientSquash',
        ];

        const cache = svc.computeMergedBranches('/repo');

        expect(names(cache.deletable)).toEqual([
            'dean/http-client',
            'dean/http-clientPreMerge2',
            'dean/http-clientSquash',
            'dean/http-clientwp3',
        ]);
        expect(cache.keep.length).toBe(0);
        const backup = cache.deletable.find((d: DeletableBranch): boolean => d.branch === 'dean/http-clientwp3');
        expect(backup?.reason).toContain("backup of 'dean/http-client'");
        expect(backup?.pr).toBe(332);
    });

    it('spares a backup whose base branch has NOT merged', () => {
        world.mergedPrs = [];
        world.localBranches = ['main', 'dean/in-flightwp2'];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/in-flightwp2']);
    });
});

describe('MergedBranchesService empty-branch husks', () => {
    /**
     * A branch with zero commits of its own holds no work — deleting it cannot lose anything. This is
     * the ONE git-local signal squash-merge cannot corrupt (it destroys patch-id and ancestry, so "is
     * this work in main?" is unanswerable — but "are there any commits at all?" is exact).
     */
    it('reaps a branch with no commits of its own, even with no PR', () => {
        world.localBranches = ['main', 'dean/never-committed'];
        world.commitsAhead = { 'dean/never-committed': 0 };

        const cache = svc.computeMergedBranches('/repo');

        expect(names(cache.deletable)).toEqual(['dean/never-committed']);
        expect(cache.deletable[0].reason).toContain('no commits of its own');
    });

    it('spares an unmerged branch that has real commits on it', () => {
        world.localBranches = ['main', 'dean/real-work'];
        world.commitsAhead = { 'dean/real-work': 3 };

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/real-work']);
    });
});

describe('MergedBranchesService safety rails', () => {
    // git refuses to delete the checked-out branch, so never propose it. It is spared LOUDLY (into
    // `keep`, with the reason) rather than dropped, so a human can see what was skipped and why.
    it('never proposes the branch you are standing on', () => {
        world.mergedPrs = [{ number: 386, headRefName: 'dean/current' }];
        world.localBranches = ['main', 'dean/current'];
        world.currentBranch = 'dean/current';

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/current']);
        expect(cache.keep[0].reason).toContain('checked out in worktree');
    });

    // Offline / gh missing / unauthenticated: we know nothing, so we must propose nothing.
    it('fails soft when gh is unavailable — everything is spared, nothing deletable', () => {
        world.ghOk = false;
        world.localBranches = ['main', 'dean/a', 'dean/b'];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/a', 'dean/b']);
    });
});

describe('MergedBranchesService worktree verdicts', () => {
    /**
     * The bug this exists to prevent: a merged branch checked out in a LINKED worktree used to land in
     * `deletable` (only the repo-root HEAD was skipped). The emitted reap is ONE `git branch -D a b c`,
     * so git's "Cannot delete branch 'x' checked out at ..." killed the whole command — including the
     * branches that would have deleted fine.
     */
    it('spares a merged branch that a LINKED worktree still holds, and reaps the worktree instead', () => {
        world.mergedPrs = [{ number: 400, headRefName: 'dean/held' }];
        world.localBranches = ['main', 'dean/held'];
        world.worktrees = [{ path: '/work/held', branch: 'dean/held' }];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/held']);
        expect(cache.keep[0].reason).toContain('/work/held');

        // The worktree carries the verdict: remove it, and the branch becomes reapable.
        expect(cache.worktrees.length).toBe(1);
        expect(cache.worktrees[0].deletable).toBe(true);
        expect(cache.worktrees[0].branch).toBe('dean/held');
    });

    it('spares a locked worktree and one holding unmerged work', () => {
        world.localBranches = ['main', 'dean/locked', 'dean/live'];
        world.worktrees = [
            { path: '/work/locked', branch: 'dean/locked', extra: 'locked because I said so' },
            { path: '/work/live', branch: 'dean/live' },
        ];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.worktrees.map((t: { deletable: boolean }): boolean => t.deletable)).toEqual([false, false]);
        expect(cache.worktrees[0].reason).toContain('locked');
    });

    it('marks a worktree whose directory is gone as prunable-deletable', () => {
        world.localBranches = ['main', 'dean/gone'];
        world.worktrees = [{ path: '/work/gone', branch: 'dean/gone', extra: 'prunable gitdir file points to nowhere' }];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.worktrees[0].deletable).toBe(true);
        expect(cache.worktrees[0].reason).toContain('prune');
    });

    it('excludes main from the local branch list', () => {
        world.localBranches = ['main', 'dean/a'];
        expect(svc.localBranches('/repo')).toEqual(['dean/a']);
    });
});

// The worktree verdicts' CLASSIFICATION half, kept in its own block: `deletable` answers "may the
// tooling reap this unattended?", the token answers "how dead is it, and how is it reaped?" — and
// wp-cleanup needs the second one to prompt, and WorktreeReaper needs it to choose prune vs remove.
describe('MergedBranchesService worktree classifications', () => {
    /**
     * The verdict data has to CLASSIFY a worktree, not merely flag it deletable — otherwise wp-cleanup
     * can auto-reap the provable ones but has nothing to prompt about, and every spared worktree
     * collapses into one undifferentiated "a human must decide" (the exact regression #509 fixed for
     * branches). The token is the branch's own, because the branch is what is being judged.
     */
    it('carries the branch classification through to the worktree verdict', () => {
        world.mergedPrs = [{ number: 400, headRefName: 'dean/held' }];
        world.allPrs = [{ number: 12, headRefName: 'dean/abandoned', state: 'CLOSED' }];
        world.localBranches = ['main', 'dean/held', 'dean/abandoned'];
        world.commitsAhead = { 'dean/abandoned': 2 };
        world.worktrees = [
            { path: '/work/held', branch: 'dean/held' },
            { path: '/work/abandoned', branch: 'dean/abandoned' },
        ];

        const cache = svc.computeMergedBranches('/repo');
        const byPath = new Map(cache.worktrees.map(
            (tree: { path: string; classification: string }): [string, string] => [tree.path, tree.classification]));

        expect(byPath.get('/work/held')).toBe(CLASSIFICATION_MERGED_PR);
        // Closed unmerged, with later PRs merged: promptable, not auto-reapable.
        expect(byPath.get('/work/abandoned')).toBe(CLASSIFICATION_SUPERSEDED);
    });

    // The three worktree-only outcomes have no branch analogue, and each needs its own token: PRUNABLE
    // is reaped with `git worktree prune` (remove FAILS on it), LOCKED and CURRENT are never promptable.
    it('gives the worktree-only outcomes their own classifications', () => {
        world.localBranches = ['main', 'dean/gone', 'dean/locked'];
        world.currentBranch = 'dean/here';
        world.worktrees = [
            { path: '/work/gone', branch: 'dean/gone', extra: 'prunable gitdir file points to nowhere' },
            { path: '/work/locked', branch: 'dean/locked', extra: 'locked because I said so' },
        ];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.worktrees[0].classification).toBe(CLASSIFICATION_PRUNABLE);
        expect(cache.worktrees[1].classification).toBe(CLASSIFICATION_LOCKED);
    });

    // The tree the refresher itself is running in is spared with its own token — nothing may ever offer
    // to remove the directory the process is standing in.
    it('classifies the worktree at repoRoot as the current one', () => {
        world.localBranches = ['main'];
        world.worktrees = [{ path: '/repo', branch: 'main' }];

        const cache = svc.computeMergedBranches('/repo');
        const here = cache.worktrees.find(
            (tree: { path: string }): boolean => tree.path === '/repo');

        expect(here?.classification).toBe(CLASSIFICATION_CURRENT);
        expect(here?.deletable).toBe(false);
    });

});

/**
 * PART 5 — the spared branches used to ALL report the identical string
 * `no merged PR found — a human must decide`. In one observed repo that one string covered a PR closed
 * unmerged and superseded by a later one, a branch that never had a PR and held the only copy of three
 * commits, and content that was already in main. Reporting them identically — then sparing rather than
 * asking — is what let the pile grow to 6 branches against a cap of 5 and wedge a session.
 *
 * Each must now produce a DISTINCT classification, and carry its unique-commit count.
 */
describe('spared-branch classification (Part 5)', () => {
    function spared(branch: string): DeletableBranch {
        const found = svc.computeMergedBranches('/repo').keep
            .find((entry: DeletableBranch): boolean => entry.branch === branch);
        if (found === undefined) throw new Error(`${branch} was not spared`);
        return found;
    }

    it('SUPERSEDED — PR closed unmerged, later PRs have merged since', () => {
        world.localBranches = ['main', 'feature/ONE-2209-morpheus-gate'];
        world.allPrs = [{ number: 752, headRefName: 'feature/ONE-2209-morpheus-gate', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 754, headRefName: 'feature/ONE-2209-morpheus-final' }];
        world.commitsAhead = { 'feature/ONE-2209-morpheus-gate': 4 };

        const entry = spared('feature/ONE-2209-morpheus-gate');

        expect(entry.classification).toBe(CLASSIFICATION_SUPERSEDED);
        expect(entry.commits).toBe(4);
        expect(entry.pr).toBe(752);
        expect(entry.reason).toContain('CLOSED UNMERGED');
        expect(entry.reason).toContain('#754');
    });

    it('NEVER-PROPOSED — no PR ever, and the unique-commit count is reported', () => {
        world.localBranches = ['main', 'dean/webpieces-0-3-322'];
        world.commitsAhead = { 'dean/webpieces-0-3-322': 3 };
        world.cherry = { 'dean/webpieces-0-3-322': '+ aaa\n+ bbb\n+ ccc\n' };

        const entry = spared('dean/webpieces-0-3-322');

        expect(entry.classification).toBe(CLASSIFICATION_NEVER_PROPOSED);
        expect(entry.commits).toBe(3);
        expect(entry.reason).toContain('never had a PR');
        expect(entry.reason).toContain('3 unique commit(s)');
    });

    it('CONTENT-ALREADY-IN-MAIN — every commit has a patch-equivalent upstream', () => {
        world.localBranches = ['main', 'dean/cherry-picked'];
        world.commitsAhead = { 'dean/cherry-picked': 2 };
        world.cherry = { 'dean/cherry-picked': '- aaa\n- bbb\n' };

        const entry = spared('dean/cherry-picked');

        expect(entry.classification).toBe(CLASSIFICATION_CONTENT_IN_MAIN);
        expect(entry.commits).toBe(2);
        expect(entry.reason).toContain('already have an equivalent in origin/main');
    });

});

describe('classification keeps the situations distinct, and still deletes nothing', () => {
    function spared(branch: string): DeletableBranch {
        const found = svc.computeMergedBranches('/repo').keep
            .find((entry: DeletableBranch): boolean => entry.branch === branch);
        if (found === undefined) throw new Error(`${branch} was not spared`);
        return found;
    }

    // The three genuinely different situations must not collapse back into one string.
    it('gives the three situations three DIFFERENT classifications and reasons', () => {
        world.localBranches = ['main', 'a/superseded', 'b/never', 'c/in-main'];
        world.allPrs = [{ number: 10, headRefName: 'a/superseded', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 20, headRefName: 'z/other' }];
        world.commitsAhead = { 'a/superseded': 1, 'b/never': 3, 'c/in-main': 2 };
        world.cherry = { 'b/never': '+ aaa\n', 'c/in-main': '- aaa\n- bbb\n' };

        const classes = svc.computeMergedBranches('/repo').keep
            .map((entry: DeletableBranch): string => entry.classification);
        const reasons = new Set(svc.computeMergedBranches('/repo').keep
            .map((entry: DeletableBranch): string => entry.reason));

        expect(new Set(classes).size).toBe(3);
        expect(reasons.size).toBe(3);
    });

    // The safety posture is UNCHANGED: classifying is not deleting. All three stay in `keep`.
    it('classifies but never auto-deletes — all three remain spared', () => {
        world.localBranches = ['main', 'a/superseded', 'b/never', 'c/in-main'];
        world.allPrs = [{ number: 10, headRefName: 'a/superseded', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 20, headRefName: 'z/other' }];
        world.commitsAhead = { 'a/superseded': 1, 'b/never': 3, 'c/in-main': 2 };
        world.cherry = { 'c/in-main': '- aaa\n- bbb\n' };

        expect(svc.computeMergedBranches('/repo').deletable).toEqual([]);
    });

    // A closed PR with NOTHING merged after it is not evidence of supersession — it may simply be work
    // someone abandoned and will come back to.
    it('does not call a branch superseded when no later PR has merged', () => {
        world.localBranches = ['main', 'dean/abandoned'];
        world.allPrs = [{ number: 99, headRefName: 'dean/abandoned', state: 'CLOSED' }];
        world.mergedPrs = [{ number: 50, headRefName: 'z/older' }];
        world.commitsAhead = { 'dean/abandoned': 2 };

        expect(spared('dean/abandoned').classification).toBe(CLASSIFICATION_NEVER_PROPOSED);
    });

    // Proven-dead branches keep their own classifications, so a report can group everything.
    it('classifies the deletable branches too', () => {
        world.mergedPrs = [{ number: 1, headRefName: 'dean/merged' }];
        world.localBranches = ['main', 'dean/merged', 'dean/mergedPreMerge1', 'dean/husk'];
        world.commitsAhead = { 'dean/husk': 0 };

        const byBranch = new Map(svc.computeMergedBranches('/repo').deletable
            .map((entry: DeletableBranch): [string, string] => [entry.branch, entry.classification]));

        expect(byBranch.get('dean/merged')).toBe(CLASSIFICATION_MERGED_PR);
        expect(byBranch.get('dean/mergedPreMerge1')).toBe(CLASSIFICATION_BACKUP_OF_MERGED);
        expect(byBranch.get('dean/husk')).toBe(CLASSIFICATION_NO_COMMITS);
    });
});
