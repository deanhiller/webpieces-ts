import { CheckoutLayout, ProcessCallDto, specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GitResultDto } from '@webpieces/tooling-common';

import { MainSyncStatusService } from '@webpieces/repo-workflow-core';
import { MAIN_SYNC_STATUS_VERSION } from '@webpieces/repo-workflow-core';
import { RulesConfigFeature } from './__tests__/rules-config-feature';


/**
 * The refresher is single-flight across the whole repo — one `.git`, one `origin/main`, one lock — but
 * it used to write a status for only the ONE branch whose worktree happened to win. Every other
 * worktree's guards then read a cross-branch cache and abstained. These tests drive the real service
 * against linked worktrees laid out on disk as git lays them out, with git's answers SCRIPTED (#1381),
 * and assert the winner now describes ALL of them.
 */

/** One worktree as `git worktree list --porcelain` reports it; `branch` is '' when detached. Data only. */
class TreeRow {
    constructor(readonly path: string, readonly head: string, readonly branch: string) {}
}

/** What git knows about the repo; the mocked git edge answers every refresh command from it. */
class RepoWorld {
    readonly trees: TreeRow[] = [];

    answer(call: ProcessCallDto): GitResultDto {
        const line = call.args.join(' ');
        if (line === 'worktree list --porcelain') return new GitResultDto(0, this.porcelain(), '');
        if (line === 'rev-parse HEAD') {
            const tree = this.trees.find((row: TreeRow): boolean => row.path === call.cwd);
            return tree === undefined ? new GitResultDto(128, '', 'not a work tree') : new GitResultDto(0, `${tree.head}\n`, '');
        }
        if (line === 'rev-parse origin/main' || line === 'rev-parse refs/heads/main') return new GitResultDto(0, 'origin-sha\n', '');
        if (line === 'merge-base origin/main HEAD') return new GitResultDto(0, 'base-sha\n', '');
        if (line.startsWith('fetch ') || line.startsWith('diff ') || line.startsWith('ls-files ')) return new GitResultDto(0, '', '');
        if (line.startsWith('rev-list --count ')) return new GitResultDto(0, '0\n', '');
        return new GitResultDto(1, '', `unscripted git ${line}`);
    }

    private porcelain(): string {
        return this.trees.map((row: TreeRow): string =>
            `worktree ${row.path}\nHEAD ${row.head}\n${row.branch === '' ? 'detached' : `branch refs/heads/${row.branch}`}\n`)
            .join('\n');
    }
}

let tmp: string;
let primary: string;
let treeB: string;
let world: RepoWorld;
let feature: RulesConfigFeature;
let service: MainSyncStatusService;

// How many times the program asked `gh` — the network cost the refresh must not scale with branches.
function ghCallCount(): number {
    return feature.processes.calls.filter((call: ProcessCallDto): boolean => call.program === 'gh').length;
}

// A primary clone on `deanhiller/a` plus a linked worktree on `deanhiller/b`. NOTHING is on `main`,
// which is the shape that proves the synthesized main entry is needed.
async function makeRepo(): Promise<void> {
    tmp = specTempDirs.makeReal('msmb-');
    primary = path.join(tmp, 'primary');
    treeB = path.join(tmp, 'tree-b');
    CheckoutLayout.primaryWithWorktree(primary, treeB, 'deanhiller/b');
    CheckoutLayout.checkoutBranch(primary, 'deanhiller/a');
    world = new RepoWorld();
    world.trees.push(new TreeRow(primary, 'sha-a', 'deanhiller/a'), new TreeRow(treeB, 'sha-b', 'deanhiller/b'));
    feature = await RulesConfigFeature.create();
    feature.git.respondToPrefix([], (call: ProcessCallDto): GitResultDto => world.answer(call));
    // `gh` exits non-zero (no PRs) — the point here is the call COUNT, not the payload.
    feature.processes.respondToPrefix('gh', [], feature.processes.fail(1, 'no remote'));
    service = feature.container.get(MainSyncStatusService);
}

beforeEach(async () => { await makeRepo(); });

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('computeAllMainSyncStatuses — every worktree in one map', () => {
    // TEST 1: the regression this whole change exists for. Two worktrees, two branches, both described
    // by the single winning refresh, so neither worktree's guards can hit the cross-branch bail-out.
    it('records EVERY worktree branch, not just the tree it ran in', async () => {
        const file = await service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches).sort()).toEqual(['deanhiller/a', 'deanhiller/b', 'main']);
        // Each entry is keyed by, and self-reports, the same branch — the guards' belt-and-braces
        // `status.branch !== branch` assertion must be unreachable.
        for (const [name, status] of Object.entries(file.branches)) {
            expect(status.branch).toBe(name);
        }
        // And each entry is a REAL status, computed in that worktree: the two feature branches sit on
        // their own HEADs, so their featureHeads are recorded rather than shared.
        expect(file.branches['deanhiller/a']?.featureHead).toBe('sha-a');
        expect(file.branches['deanhiller/b']?.featureHead).toBe('sha-b');
        expect(file.version).toBe(MAIN_SYNC_STATUS_VERSION);
    });

    // TEST 6: read-stale-guard's state A looks itself up under 'main'. With nothing checked out on
    // main, an absent entry would silently disarm the stale-main block.
    it('always includes main, even with no worktree standing on it', async () => {
        const file = await service.computeAllMainSyncStatuses(primary);
        const main = file.branches['main'];
        expect(main).toBeDefined();
        expect(main?.branch).toBe('main');
        // It carries the two hashes the stale-main guards actually compare.
        expect(main?.originMain).not.toBe('');
        expect(main?.localMain).not.toBe('');
        // And it can never produce a merged-branch or conflict block.
        expect(main?.branchAlreadyMerged).toBe(false);
        expect(main?.conflict).toBe(false);
    });

    // TEST 5: a detached worktree has no branch to key an entry on. Skipping it must not cost the
    // other worktrees their entries.
    it('skips a detached-HEAD worktree without dropping the others', async () => {
        world.trees.push(new TreeRow(path.join(tmp, 'tree-detached'), 'sha-d', ''));

        const file = await service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches).sort()).toEqual(['deanhiller/a', 'deanhiller/b', 'main']);
        expect(Object.keys(file.branches)).not.toContain('');
    });

    // TEST 7: the map is rebuilt from the LIVE worktree set every refresh, so nothing accumulates and
    // no pruning pass is needed.
    it('drops a removed worktree\'s branch on the next refresh', async () => {
        expect(Object.keys(await service.computeAllMainSyncStatuses(primary))).toBeDefined();
        // `git worktree remove` + `git branch -D deanhiller/b`: git no longer lists the tree.
        world.trees.splice(1, 1);

        const file = await service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches).sort()).toEqual(['deanhiller/a', 'main']);
    });

    // TEST 9: the network cost must NOT scale with branch count. The old code asked `gh` twice PER
    // BRANCH, so looping worktrees would have cost 2N round trips per refresh.
    it('makes exactly ONE gh call no matter how many branches it records', async () => {
        world.trees.push(new TreeRow(path.join(tmp, 'tree-c'), 'sha-c', 'deanhiller/c'),
            new TreeRow(path.join(tmp, 'tree-d'), 'sha-d', 'deanhiller/d'));

        const file = await service.computeAllMainSyncStatuses(primary);

        expect(Object.keys(file.branches)).toHaveLength(5);
        expect(ghCallCount()).toBe(1);
        // ...and ONE fetch.
        expect(feature.git.callsStartingWith(['fetch'])).toHaveLength(1);
    });

    // Regression pin on the single-branch entry point too: it used to make TWO gh calls.
    it('computeMainSyncStatus makes one gh call for its single branch', async () => {
        await service.computeMainSyncStatus(primary);
        expect(ghCallCount()).toBe(1);
    });

    // The whole map is written as ONE atomic document, and every worktree reads the same path — so a
    // guard in tree B finds tree B's entry through the file written by the refresher in the primary.
    it('round-trips the map through the shared file, readable from every worktree', async () => {
        service.writeMainSyncStatusFile(primary, await service.computeAllMainSyncStatuses(primary));

        expect(service.mainSyncStatusPath(treeB)).toBe(service.mainSyncStatusPath(primary));
        expect(service.readMainSyncStatus(treeB, 'deanhiller/b')?.branch).toBe('deanhiller/b');
        expect(service.readMainSyncStatus(primary, 'deanhiller/a')?.branch).toBe('deanhiller/a');
        expect(service.readMainSyncStatus(treeB, 'never/created')).toBeNull();
    });
});
