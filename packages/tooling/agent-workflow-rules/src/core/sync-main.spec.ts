import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { MainSyncLock, MainSyncLockService, MainSyncStatusService, RefreshOutcome } from '@webpieces/repo-workflow-core';


import { refreshMainSync } from './sync-main';

// Log FILENAMES now carry the stream prefix (see LogStream). Specs resolve the name the same way
// production does, so the layout is regression-tested on the REAL path rather than a fallback.
import { LogStream } from './log-stream';
import { L2_DECISIONS_STREAM, CALLS_STREAM, ASYNC_REFRESH_STREAM, REJECTIONS_STREAM } from './log-streams';
// One writer's path inside a STREAM DIRECTORY — `<stream>/<sessionId>-<agent>-<hook><suffix>`, the
// real layout production builds. Takes the stream CONSTANT, so no dead filename survives in a fixture.
function streamName(stream: string, suffix: string = '.log'): string {
    return path.join(stream, new LogStream().writerFile(suffix));
}


/**
 * SINGLE-FLIGHT IS UNCHANGED by the move to a branch-keyed map.
 *
 * The map changed only WHAT the winner writes — one `.git`, one `origin/main`, one fetch, one
 * refresher, the same lock. That is worth a test of its own, because "record every worktree" is
 * exactly the kind of change that invites letting a second refresher run per worktree.
 */

let root: string;
const service = new MainSyncStatusService();
const locks = new MainSyncLockService(undefined, undefined, service);

/**
 * What the status file held at the instant the lock was deleted — the ORDERING contract: the stamp must
 * be on disk before any other process can win the next lock race.
 */
class SeenAtRelease {
    value: number | null = null;
}

function stampAtRelease(): SeenAtRelease {
    const seen = new SeenAtRelease();
    const original = MainSyncLockService.prototype.releaseMainSyncLock;
    vi.spyOn(MainSyncLockService.prototype, 'releaseMainSyncLock').mockImplementation(
        function (this: MainSyncLockService, repoRoot: string, held: MainSyncLock): boolean {
            seen.value = service.readMainSyncStatusFile(repoRoot)?.lastRefreshStartedMs ?? null;
            return original.call(this, repoRoot, held);
        });
    return seen;
}

function asyncLog(): string {
    const logPath = path.join(root, '.webpieces', 'logs', streamName(ASYNC_REFRESH_STREAM));
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

beforeEach(() => {
    root = specTempDirs.makeReal('syncmain-');
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('sync-main single-flight', () => {
    it('a child whose claim is no longer the lock logs SKIP_INPROGRESS and writes no status at all', () => {
        // A live refresher (this very process's pid, so the liveness probe says "running") holds the
        // lock — it reclaimed it while this child booted. This child must not fetch, compute or write.
        const held = Date.now();
        locks.writeMainSyncLock(root, new MainSyncLock(process.pid, held));

        refreshMainSync(root, held - 1);

        expect(asyncLog()).toContain('SKIP_INPROGRESS');
        expect(asyncLog()).not.toContain('FINISH');
        expect(fs.existsSync(service.mainSyncStatusPath(root))).toBe(false);
        // The holder's lock is untouched — a loser must never delete it.
        expect(locks.readMainSyncLock(root)).toEqual(new MainSyncLock(process.pid, held));
    });

    it('on success: adopts its spawner`s lock, stamps the status file FIRST, deletes the lock LAST', () => {
        const claim = locks.claimRefresh(root, 5).lock;
        expect(claim).not.toBeNull();
        const started = claim?.startedMs ?? 0;
        const seen = stampAtRelease();

        refreshMainSync(root, started);

        // It got past the adopt. The run is a no-op in a non-git directory, but it completes.
        expect(asyncLog()).toContain('FINISH');
        expect(asyncLog()).not.toContain('SKIP_INPROGRESS');
        expect(seen.value).toBe(started);
        expect(service.readMainSyncStatusFile(root)?.lastRefreshOutcome).toBe(RefreshOutcome.OK);
        expect(fs.existsSync(locks.mainSyncLockPath(root))).toBe(false);
    });

    it('on error: records the stamp with outcome error, keeps old branch data, and still deletes the lock', () => {
        service.writeMainSyncStatusFile(root, service.computeAllMainSyncStatuses(root));
        const before = Object.keys(service.readMainSyncStatusFile(root)?.branches ?? {});
        vi.spyOn(MainSyncStatusService.prototype, 'computeAllMainSyncStatuses').mockImplementation((): never => {
            throw new Error('offline');
        });
        const claim = locks.claimRefresh(root, 5).lock;
        const started = claim?.startedMs ?? 0;
        const seen = stampAtRelease();

        refreshMainSync(root, started);

        expect(asyncLog()).toContain('offline');
        expect(seen.value).toBe(started);
        const file = service.readMainSyncStatusFile(root);
        expect(file?.lastRefreshOutcome).toBe(RefreshOutcome.ERROR);
        expect(Object.keys(file?.branches ?? {})).toEqual(before);
        expect(fs.existsSync(locks.mainSyncLockPath(root))).toBe(false);
    });

    it('a hand-run with no lock handed to it adopts nothing and leaves an existing lock alone', () => {
        const other = new MainSyncLock(process.pid, Date.now());
        locks.writeMainSyncLock(root, other);
        refreshMainSync(root, Number.NaN);
        expect(asyncLog()).toContain('SKIP_INPROGRESS');
        expect(locks.readMainSyncLock(root)).toEqual(other);
    });
});
