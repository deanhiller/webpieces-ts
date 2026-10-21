import { describe, it, expect, vi, beforeEach } from 'vitest';

// One spawnSync the detached refresher made, with the timeout it passed.
type SpawnCall = { cmd: string; args: string[]; timeout: number | undefined };

const calls = vi.hoisted((): SpawnCall[] => []);

vi.mock('child_process', () => ({
    spawnSync: (cmd: string, args: string[], options: { timeout?: number }): { status: number; stdout: string; stderr: string } => {
        calls.push({ cmd, args, timeout: options.timeout });
        // A worktree listing with one primary tree on a feature branch, so the per-branch local git runs.
        if (cmd === 'git' && args[0] === 'worktree') {
            return { status: 0, stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/dean/x\n\n', stderr: '' };
        }
        if (cmd === 'gh') return { status: 0, stdout: '[]', stderr: '' };
        return { status: 0, stdout: 'abc', stderr: '' };
    },
}));

import { CommandTimeouts } from './command-timeouts';
import { MainSyncStatusService } from './main-sync-status';
import { MergedBranchesService } from './merged-branches';

function describeCall(c: SpawnCall): string {
    return `${c.cmd} ${c.args.join(' ')}`;
}

/**
 * #1342: a hung `git fetch` over ssh, or a hung `gh pr list`, used to live forever, because no command
 * the refresher ran carried a timeout — and every stale-lock reclaim could stack another one beside it.
 * This pins that EVERY command of a full refresh is bounded, and that the network ones get the network
 * ceiling. It drives the real code paths, so a new spawn added without a timeout turns it red.
 */
describe('every command the detached refresher runs is bounded', () => {
    beforeEach(() => { calls.length = 0; });

    it('computeAllMainSyncStatuses and computeMergedBranches pass a timeout on every spawn', () => {
        new MainSyncStatusService().computeAllMainSyncStatuses('/repo');
        new MergedBranchesService().computeMergedBranches('/repo', false);

        expect(calls.length).toBeGreaterThan(3);
        const unbounded = calls.filter((c: SpawnCall): boolean => c.timeout === undefined || c.timeout <= 0);
        expect(unbounded.map(describeCall)).toEqual([]);
    });

    it('git fetch and gh get the network ceiling; local git gets the local one', () => {
        new MainSyncStatusService().computeAllMainSyncStatuses('/repo');

        const fetch = calls.find((c: SpawnCall): boolean => c.cmd === 'git' && c.args[0] === 'fetch');
        const gh = calls.find((c: SpawnCall): boolean => c.cmd === 'gh');
        const local = calls.find((c: SpawnCall): boolean => c.cmd === 'git' && c.args[0] !== 'fetch');
        expect(fetch?.timeout).toBe(CommandTimeouts.NETWORK_MS);
        expect(gh?.timeout).toBe(CommandTimeouts.NETWORK_MS);
        expect(local?.timeout).toBe(CommandTimeouts.LOCAL_GIT_MS);
    });

    it('the two network calls of one run fit well inside the default 5-minute hang window', () => {
        expect(2 * CommandTimeouts.NETWORK_MS).toBeLessThan(5 * 60 * 1000);
    });
});
