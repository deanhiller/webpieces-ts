import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessResultDto } from '@webpieces/tooling-common';
import { MockScheduledTask, ProcessCallDto } from '@webpieces/tooling-testkit';

import { WorkflowFeature } from './__tests__/workflow-feature';
import { CommandTimeouts } from './command-timeouts';
import { MainSyncStatusService } from './main-sync-status';
import { MergedBranchesService } from './merged-branches';

let feature: WorkflowFeature;

// The deadline the program scheduled for one command, found by the command it bounds.
function deadlineFor(commandLine: string): MockScheduledTask | undefined {
    return feature.timer.getAllScheduledTasks().find((task: MockScheduledTask): boolean =>
        task.task.description === `deadline for \`${commandLine}\``);
}

// Every command the program ran asynchronously (each must carry a deadline), git and gh alike.
function asyncCommands(): string[] {
    return [...feature.git.calls, ...feature.processes.calls]
        .filter((call: ProcessCallDto): boolean => call.mode === 'run')
        .map((call: ProcessCallDto): string => call.commandLine);
}

// Let the program's pending awaits run — no real time passes.
async function drain(until: () => boolean): Promise<void> {
    for (let turn = 0; turn < 1000 && !until(); turn += 1) await Promise.resolve();
}

beforeEach(async () => {
    feature = await WorkflowFeature.create();
    // One primary tree on a feature branch, so the per-branch local git runs; every other git answers 'abc'.
    feature.git.respond(['worktree', 'list', '--porcelain'],
        feature.git.ok('worktree /repo\nHEAD abc\nbranch refs/heads/dean/x\n\n'));
    feature.git.respondToPrefix([], feature.git.ok('abc'));
});

// `gh` answers an empty PR list.
function ghAnswersNoPrs(): void {
    feature.processes.respondToPrefix('gh', ['pr', 'list'], feature.processes.ok('[]'));
}

/**
 * #1342: a hung `git fetch` over ssh, or a hung `gh pr list`, used to live forever, because no command
 * the refresher ran carried a timeout — and every stale-lock reclaim could stack another one beside it.
 * This pins that EVERY command of a full refresh is bounded, and that the network ones get the network
 * ceiling. It drives the real code paths, so a new command added without a deadline turns it red.
 */
describe('every command the detached refresher runs is bounded', () => {
    it('computeAllMainSyncStatuses and computeMergedBranches pass a timeout on every spawn', async () => {
        ghAnswersNoPrs();
        await feature.container.get(MainSyncStatusService).computeAllMainSyncStatuses('/repo');
        await feature.container.get(MergedBranchesService).computeMergedBranches('/repo', false);

        const commands = asyncCommands();
        expect(commands.length).toBeGreaterThan(3);
        // Every asynchronous command scheduled a deadline, and every one of those was cancelled once the
        // command answered — none is left to fire later.
        const unbounded = commands.filter((command: string): boolean => {
            const deadline = deadlineFor(command);
            return deadline === undefined || deadline.delayMs <= 0;
        });
        expect(unbounded).toEqual([]);
        expect(feature.timer.getScheduledTasks()).toEqual([]);
        // The synchronous worktree listing carries its kill-after to the edge.
        const unboundedSync = feature.git.calls.filter((call: ProcessCallDto): boolean =>
            call.mode === 'runSync' && (call.timeoutMs === undefined || call.timeoutMs <= 0));
        expect(unboundedSync.map((call: ProcessCallDto): string => call.commandLine)).toEqual([]);
    });

    it('git fetch and gh get the network ceiling; local git gets the local one', async () => {
        ghAnswersNoPrs();
        await feature.container.get(MainSyncStatusService).computeAllMainSyncStatuses('/repo');

        const commands = asyncCommands();
        const fetch = commands.find((command: string): boolean => command.startsWith('git fetch'));
        const gh = commands.find((command: string): boolean => command.startsWith('gh '));
        const local = commands.find((command: string): boolean => command.startsWith('git ') && !command.startsWith('git fetch'));
        expect(deadlineFor(fetch ?? '')?.delayMs).toBe(CommandTimeouts.NETWORK_MS);
        expect(deadlineFor(gh ?? '')?.delayMs).toBe(CommandTimeouts.NETWORK_MS);
        expect(deadlineFor(local ?? '')?.delayMs).toBe(CommandTimeouts.LOCAL_GIT_MS);
    });

    it('the two network calls of one run fit well inside the default 5-minute hang window', () => {
        expect(2 * CommandTimeouts.NETWORK_MS).toBeLessThan(5 * 60 * 1000);
    });

    it('a hung command is killed when its deadline fires, and the refresh carries on without it', async () => {
        // `gh` never answers on its own: the test holds it in flight.
        const hung = new Promise<ProcessResultDto>((): void => undefined);
        feature.processes.respondToPrefix('gh', ['pr', 'list'], hung);
        const command = 'gh pr list --state all --json number,headRefName,state --limit 200';

        const refresh = feature.container.get(MainSyncStatusService).computeAllMainSyncStatuses('/repo');
        await drain((): boolean => deadlineFor(command) !== undefined);
        const deadline = deadlineFor(command);
        expect(deadline?.delayMs).toBe(CommandTimeouts.NETWORK_MS);
        deadline?.run();
        const file = await refresh;

        // The killed `gh` reads as an unreachable forge — the documented fail-open answer — not a hang.
        expect(file.branches['dean/x']?.forgeReachable).toBe(false);
    });
});
