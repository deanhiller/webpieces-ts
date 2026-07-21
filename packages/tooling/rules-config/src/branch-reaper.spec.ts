import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors merged-branches.spec.ts: a fake git/gh world, so the reaper's real logic runs against
// controlled verdicts. `deletes` is the assertion surface that matters most — it records EVERY
// `git branch -D` invocation, which is how we prove one-branch-per-command.
const world = vi.hoisted(() => ({
    mergedPrs: [] as { number: number; headRefName: string }[],
    localBranches: [] as string[],
    currentBranch: 'main',
    commitsAhead: {} as Record<string, number>,
    // Branch → SHA that `git rev-parse <branch>` resolves to.
    shas: {} as Record<string, string>,
    // Branches whose `git branch -D` fails, mapped to git's stderr.
    deleteFails: {} as Record<string, string>,
    // Every `git branch -D` invocation, as the list of branch names it was given.
    deletes: [] as string[][],
    written: [] as string[],
    logLines: [] as string[],
}));

vi.mock('child_process', () => ({
    spawnSync: (cmd: string, args: string[]): { status: number; stdout: string; stderr: string } => {
        if (cmd === 'gh') return { status: 0, stdout: JSON.stringify(world.mergedPrs), stderr: '' };
        if (cmd !== 'git') return { status: 1, stdout: '', stderr: '' };

        if (args[0] === 'for-each-ref') {
            return { status: 0, stdout: world.localBranches.join('\n') + '\n', stderr: '' };
        }
        if (args[0] === 'worktree') {
            return {
                status: 0,
                stdout: `worktree /repo\nHEAD aaa\nbranch refs/heads/${world.currentBranch}\n`,
                stderr: '',
            };
        }
        if (args[0] === 'rev-list') {
            const branch = String(args[2]).replace('origin/main..', '');
            return { status: 0, stdout: String(world.commitsAhead[branch] ?? 1), stderr: '' };
        }
        if (args[0] === 'rev-parse') {
            const sha = world.shas[String(args[1])];
            if (sha === undefined) return { status: 1, stdout: '', stderr: 'unknown revision' };
            return { status: 0, stdout: sha, stderr: '' };
        }
        if (args[0] === 'branch' && args[1] === '-D') {
            world.deletes.push(args.slice(2));
            const failure = world.deleteFails[String(args[2])];
            if (failure !== undefined) return { status: 1, stdout: '', stderr: failure };
            return { status: 0, stdout: `Deleted branch ${String(args[2])}`, stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
    },
}));

// Capture what lands on disk without touching the filesystem.
vi.mock('fs', () => ({
    mkdirSync: (): void => undefined,
    statSync: (): never => { throw new Error('no log file yet'); },
    existsSync: (): boolean => false,
    appendFileSync: (_p: string, line: string): void => { world.logLines.push(line); },
    writeFileSync: (_p: string, body: string): void => { world.written.push(body); },
    readFileSync: (): string => '{}',
}));

import { BranchReaper, ReapedBranch } from './branch-reaper';

const reaper = new BranchReaper();

function names(list: ReapedBranch[]): string[] {
    return list.map((entry: ReapedBranch): string => entry.branch).sort();
}

beforeEach(() => {
    world.mergedPrs = [];
    world.localBranches = [];
    world.currentBranch = 'main';
    world.commitsAhead = {};
    world.shas = {};
    world.deleteFails = {};
    world.deletes = [];
    world.written = [];
    world.logLines = [];
});

describe('BranchReaper.reap', () => {
    it('deletes merged branches and spares the ones with unmerged work', () => {
        world.mergedPrs = [{ number: 430, headRefName: 'dean/merged' }];
        world.localBranches = ['main', 'dean/merged', 'dean/in-flight'];
        world.shas = { 'dean/merged': 'abc123' };

        const result = reaper.reap('/repo', 'wp-cleanup');

        expect(names(result.reaped)).toEqual(['dean/merged']);
        expect(result.failed.length).toBe(0);
        expect(result.spared.map((entry: { branch: string }): string => entry.branch)).toEqual(['dean/in-flight']);
    });

    /**
     * The bug the old fix hint carried: it emitted ONE `git branch -D a b c`, so the first branch git
     * refused took every branch after it down with it. One invocation per branch means one failure
     * costs exactly one branch.
     */
    it('issues one git branch -D per branch, never a multi-name command', () => {
        world.mergedPrs = [
            { number: 1, headRefName: 'dean/a' },
            { number: 2, headRefName: 'dean/b' },
            { number: 3, headRefName: 'dean/c' },
        ];
        world.localBranches = ['main', 'dean/a', 'dean/b', 'dean/c'];

        reaper.reap('/repo', 'wp-cleanup');

        expect(world.deletes).toEqual([['dean/a'], ['dean/b'], ['dean/c']]);
    });

    // The safety property that makes an unattended delete acceptable: the tip is captured BEFORE the
    // branch is destroyed, and the log carries the exact command that puts it back.
    it('captures the pre-delete SHA and logs a recover command', () => {
        world.mergedPrs = [{ number: 430, headRefName: 'dean/merged' }];
        world.localBranches = ['main', 'dean/merged'];
        world.shas = { 'dean/merged': '58368f2deadbeef' };

        const result = reaper.reap('/repo', 'auto-reap');

        expect(result.reaped[0].sha).toBe('58368f2deadbeef');
        const line = world.logLines.join('');
        expect(line).toContain('auto-reap');
        expect(line).toContain('REAP');
        expect(line).toContain('recover=git branch dean/merged 58368f2deadbeef');
        // A delete has no destination — `to=?` would read as a lost one.
        expect(line).toContain('branch=dean/merged');
        expect(line).not.toContain('to=?');
    });
});

describe('BranchReaper safety rails and failure handling', () => {
    it('keeps reaping after one delete fails, and reports the failure with git stderr', () => {
        world.mergedPrs = [
            { number: 1, headRefName: 'dean/a' },
            { number: 2, headRefName: 'dean/stuck' },
            { number: 3, headRefName: 'dean/c' },
        ];
        world.localBranches = ['main', 'dean/a', 'dean/stuck', 'dean/c'];
        world.deleteFails = { 'dean/stuck': "error: cannot delete branch 'dean/stuck' checked out at '/work'" };

        const result = reaper.reap('/repo', 'wp-cleanup');

        expect(names(result.reaped)).toEqual(['dean/a', 'dean/c']);
        expect(names(result.failed)).toEqual(['dean/stuck']);
        expect(result.failed[0].error).toContain('checked out at');
    });

    // merged-branches.ts already guarantees this (a held branch lands in `keep`), but the reaper is
    // what actually runs `-D`, so the guarantee is worth pinning down here too.
    it('never deletes the branch that is checked out', () => {
        world.mergedPrs = [{ number: 434, headRefName: 'dean/current' }];
        world.localBranches = ['main', 'dean/current'];
        world.currentBranch = 'dean/current';

        const result = reaper.reap('/repo', 'wp-cleanup');

        expect(result.reaped.length).toBe(0);
        expect(world.deletes).toEqual([]);
        expect(result.spared[0].reason).toContain('checked out in worktree');
    });

    /**
     * `gh` down means no merged-PR evidence at all, so every branch with commits is spared. A cleanup
     * command that deleted on an empty evidence set would be catastrophic exactly when the network is
     * flaky — the direction of failure has to be "do nothing".
     */
    it('deletes nothing when the branches all still have work', () => {
        world.localBranches = ['main', 'dean/a', 'dean/b'];
        world.commitsAhead = { 'dean/a': 3, 'dean/b': 1 };

        const result = reaper.reap('/repo', 'wp-cleanup');

        expect(result.reaped.length).toBe(0);
        expect(world.deletes).toEqual([]);
    });

    // The cap must stop blocking against branches that no longer exist, so the rewritten cache keeps
    // only what genuinely survived (here: the branch whose delete failed).
    it('rewrites the cache with only the branches that failed to delete', () => {
        world.mergedPrs = [
            { number: 1, headRefName: 'dean/gone' },
            { number: 2, headRefName: 'dean/stuck' },
        ];
        world.localBranches = ['main', 'dean/gone', 'dean/stuck'];
        world.deleteFails = { 'dean/stuck': 'error: some reason' };

        reaper.reap('/repo', 'wp-cleanup');

        const written = JSON.parse(world.written[world.written.length - 1]) as {
            deletable: { branch: string }[];
        };
        expect(written.deletable.map((entry: { branch: string }): string => entry.branch)).toEqual(['dean/stuck']);
    });
});
