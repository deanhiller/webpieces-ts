import { describe, it, expect, vi, beforeEach } from 'vitest';

// What the mocked `gh pr list --state merged` returns, and what `git for-each-ref` sees locally.
const world = vi.hoisted(() => ({
    mergedPrs: [] as { number: number; headRefName: string }[],
    localBranches: [] as string[],
    currentBranch: 'main',
    ghOk: true,
    // Commits each branch has that origin/main does not. Anything absent is assumed to have work.
    commitsAhead: {} as Record<string, number>,
}));

vi.mock('child_process', () => ({
    spawnSync: (cmd: string, args: string[]): { status: number; stdout: string } => {
        if (cmd === 'gh') {
            if (!world.ghOk) return { status: 1, stdout: '' };
            return { status: 0, stdout: JSON.stringify(world.mergedPrs) };
        }
        if (cmd === 'git' && args[0] === 'for-each-ref') {
            return { status: 0, stdout: world.localBranches.join('\n') + '\n' };
        }
        if (cmd === 'git' && args.includes('--abbrev-ref')) {
            return { status: 0, stdout: `${world.currentBranch}\n` };
        }
        if (cmd === 'git' && args[0] === 'rev-list') {
            const branch = String(args[2]).replace('origin/main..', '');
            return { status: 0, stdout: String(world.commitsAhead[branch] ?? 1) };
        }
        return { status: 1, stdout: '' };
    },
}));

import { MergedBranchesService, DeletableBranch } from './merged-branches';

function names(list: DeletableBranch[]): string[] {
    return list.map((entry: DeletableBranch): string => entry.branch).sort();
}

const svc = new MergedBranchesService();

beforeEach(() => {
    world.mergedPrs = [];
    world.localBranches = [];
    world.currentBranch = 'main';
    world.ghOk = true;
    world.commitsAhead = {};
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
    // git refuses to delete the checked-out branch, so never propose it.
    it('never proposes the branch you are standing on', () => {
        world.mergedPrs = [{ number: 386, headRefName: 'dean/current' }];
        world.localBranches = ['main', 'dean/current'];
        world.currentBranch = 'dean/current';

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(cache.keep.length).toBe(0);
    });

    // Offline / gh missing / unauthenticated: we know nothing, so we must propose nothing.
    it('fails soft when gh is unavailable — everything is spared, nothing deletable', () => {
        world.ghOk = false;
        world.localBranches = ['main', 'dean/a', 'dean/b'];

        const cache = svc.computeMergedBranches('/repo');

        expect(cache.deletable.length).toBe(0);
        expect(names(cache.keep)).toEqual(['dean/a', 'dean/b']);
    });

    it('excludes main from the local branch list', () => {
        world.localBranches = ['main', 'dean/a'];
        expect(svc.localBranches('/repo')).toEqual(['dean/a']);
    });
});
