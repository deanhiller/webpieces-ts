import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
    MAIN_SYNC_LOCK_PURPOSE,
    MIN_REFRESH_INTERVAL_MINUTES,
    MainSyncLock,
    MainSyncLockService,
    MainSyncStatus,
    MainSyncStatusService,
    RefreshClaimOutcome,
    RefreshOutcome,
    SPAWNER_CLAIM_PID,
} from '@webpieces/repo-workflow-core';

// Lives in rules-config beside main-sync-status.spec.ts (as the lock tests always have) so that
// repo-workflow-core keeps no dependency on tooling-testkit.

const MINUTE = 60 * 1000;
const HANG = 5;

let root: string;
let status: MainSyncStatusService;
let locks: MainSyncLockService;

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
    return new Promise((resolve: (signal: NodeJS.Signals | null) => void): void => {
        child.once('exit', (_code: number | null, signal: NodeJS.Signals | null): void => resolve(signal));
    });
}

function lockExists(): boolean {
    return fs.existsSync(locks.mainSyncLockPath(root));
}

function stampRefresh(startedMs: number): void {
    status.recordRefreshOutcome(root, startedMs, RefreshOutcome.OK);
}

beforeEach(() => {
    root = specTempDirs.makeReal('wp-lock-');
    status = new MainSyncStatusService();
    locks = new MainSyncLockService(undefined, undefined, status);
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// The lock is a MUTEX and nothing else: its existence is the lock, the creator deletes it.
describe('main-sync.lock.json is a minimal mutex', () => {
    it('holds only purpose, pid and startedMs', () => {
        locks.tryAcquireMainSyncLock(root, HANG, 1234, 77);
        const raw = JSON.parse(fs.readFileSync(locks.mainSyncLockPath(root), 'utf8')) as Record<string, unknown>;
        expect(Object.keys(raw).sort()).toEqual(['pid', 'purpose', 'startedMs']);
        expect(raw).toEqual({ purpose: MAIN_SYNC_LOCK_PURPOSE, pid: 77, startedMs: 1234 });
    });

    it('the first creator wins; a loser gets EEXIST and skips', () => {
        const now = Date.now();
        expect(locks.tryAcquireMainSyncLock(root, HANG, now, process.pid)).not.toBeNull();
        expect(locks.tryAcquireMainSyncLock(root, HANG, now, process.pid)).toBeNull();
    });

    it('the winner deletes it, after which the next create wins at once', () => {
        const mine = locks.tryAcquireMainSyncLock(root, HANG, Date.now(), process.pid);
        expect(mine).not.toBeNull();
        if (mine !== null) expect(locks.releaseMainSyncLock(root, mine)).toBe(true);
        expect(lockExists()).toBe(false);
        expect(locks.tryAcquireMainSyncLock(root, HANG, Date.now(), process.pid)).not.toBeNull();
    });

    it('an old run never deletes a NEWER holder`s lock', () => {
        const old = new MainSyncLock(1111, 100 * MINUTE);
        const newer = new MainSyncLock(2222, 120 * MINUTE);
        locks.writeMainSyncLock(root, newer);   // the hung `old` was reclaimed meanwhile

        expect(locks.releaseMainSyncLock(root, old)).toBe(false);
        expect(locks.readMainSyncLock(root)).toEqual(newer);
    });

    it('leaves no temp files behind, win or lose', () => {
        locks.tryAcquireMainSyncLock(root, HANG, Date.now(), process.pid);
        locks.tryAcquireMainSyncLock(root, HANG, Date.now(), process.pid);
        const names = fs.readdirSync(path.dirname(locks.mainSyncLockPath(root)));
        expect(names.filter((n: string): boolean => n.endsWith('.tmp'))).toEqual([]);
    });
});

describe('reclaiming a crashed or hung holder', () => {
    it('a live holder inside its hang window is left alone', () => {
        const now = Date.now();
        locks.writeMainSyncLock(root, new MainSyncLock(process.pid, now - MINUTE));
        expect(locks.tryAcquireMainSyncLock(root, HANG, now, 4242)).toBeNull();
    });

    it('a dead holder is reclaimed at once', () => {
        const now = Date.now();
        locks.writeMainSyncLock(root, new MainSyncLock(2147483646, now - MINUTE));
        expect(locks.tryAcquireMainSyncLock(root, HANG, now, 4242)).toEqual(new MainSyncLock(4242, now));
    });

    it('a stale holder that is still alive is SIGKILLed, then its lock reclaimed', async () => {
        const hung = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
        const gone = exited(hung);
        const now = Date.now();
        locks.writeMainSyncLock(root, new MainSyncLock(hung.pid ?? 0, now - 30 * MINUTE));

        expect(locks.tryAcquireMainSyncLock(root, HANG, now, 4242)).not.toBeNull();
        expect(await gone).toBe('SIGKILL');
    });

    it('never signals its own process', () => {
        const now = Date.now();
        locks.writeMainSyncLock(root, new MainSyncLock(process.pid, now - 30 * MINUTE));
        expect(locks.tryAcquireMainSyncLock(root, HANG, now, process.pid)).not.toBeNull();
    });

    it('a spawner`s unadopted lock (pid 0) is judged by age alone', () => {
        const now = Date.now();
        locks.writeMainSyncLock(root, new MainSyncLock(SPAWNER_CLAIM_PID, now - MINUTE));
        expect(locks.tryAcquireMainSyncLock(root, HANG, now, 4242)).toBeNull();
        expect(locks.tryAcquireMainSyncLock(root, HANG, now + 10 * MINUTE, 4242)).not.toBeNull();
    });

    it('a retired `state: finished` lock is garbage, reclaimed at once rather than honoured', () => {
        fs.mkdirSync(path.dirname(locks.mainSyncLockPath(root)), { recursive: true });
        fs.writeFileSync(locks.mainSyncLockPath(root), JSON.stringify({ state: 'finished', started: Date.now(), pid: 0 }));
        expect(locks.readMainSyncLock(root)).toEqual(new MainSyncLock(0, 0));
        expect(locks.tryAcquireMainSyncLock(root, HANG, Date.now(), 4242)).not.toBeNull();
    });

    it('an unparseable lock is garbage too', () => {
        fs.mkdirSync(path.dirname(locks.mainSyncLockPath(root)), { recursive: true });
        fs.writeFileSync(locks.mainSyncLockPath(root), '{not json');
        expect(locks.tryAcquireMainSyncLock(root, HANG, Date.now(), 4242)).not.toBeNull();
    });
});

// #1342: the throttle lives in the spawner and reads the status file's stamp.
describe('claimRefresh — at most one refresh START per interval', () => {
    it('is due when no refresh was ever recorded', () => {
        const now = Date.now();
        const claim = locks.claimRefresh(root, HANG, now);
        expect(claim.outcome).toBe(RefreshClaimOutcome.CLAIMED);
        expect(locks.readMainSyncLock(root)).toEqual(new MainSyncLock(SPAWNER_CLAIM_PID, now));
    });

    it('skips inside the interval without touching the lock', () => {
        const now = Date.now();
        stampRefresh(now - (MIN_REFRESH_INTERVAL_MINUTES - 1) * MINUTE);
        expect(locks.claimRefresh(root, HANG, now).outcome).toBe(RefreshClaimOutcome.RECENT);
        expect(lockExists()).toBe(false);
    });

    it('a FAILED run is throttled exactly like a successful one', () => {
        const now = Date.now();
        status.recordRefreshOutcome(root, now - MINUTE, RefreshOutcome.ERROR);
        expect(locks.claimRefresh(root, HANG, now).outcome).toBe(RefreshClaimOutcome.RECENT);
    });

    it('proceeds once the interval has elapsed', () => {
        const now = Date.now();
        const last = now - (MIN_REFRESH_INTERVAL_MINUTES + 1) * MINUTE;
        stampRefresh(last);
        const claim = locks.claimRefresh(root, HANG, now);
        expect(claim.outcome).toBe(RefreshClaimOutcome.CLAIMED);
        expect(claim.lastRefreshStartedMs).toBe(last);
    });

    it('past the interval, a running holder still wins: the caller skips', () => {
        const now = Date.now();
        stampRefresh(now - 60 * MINUTE);
        locks.writeMainSyncLock(root, new MainSyncLock(process.pid, now - MINUTE));
        expect(locks.claimRefresh(root, HANG, now).outcome).toBe(RefreshClaimOutcome.HELD);
    });
});

describe('the child adopts its spawner`s lock', () => {
    it('takes over the pid of the lock it was handed', () => {
        const now = Date.now();
        locks.claimRefresh(root, HANG, now);
        expect(locks.adoptMainSyncLock(root, now, 4242)).toEqual(new MainSyncLock(4242, now));
        expect(locks.readMainSyncLock(root)?.pid).toBe(4242);
    });

    it('refuses a lock that is not the one it was handed', () => {
        const now = Date.now();
        locks.claimRefresh(root, HANG, now);
        expect(locks.adoptMainSyncLock(root, now - 1, 4242)).toBeNull();
        expect(locks.adoptMainSyncLock(root, Number.NaN, 4242)).toBeNull();
    });
});

describe('the throttle stamp lives in main-sync-status.json', () => {
    const entry = (branch: string): MainSyncStatus =>
        new MainSyncStatus(branch, false, '', true, 'a', 'b', 'c', false, [], 'ts');

    it('recording a failed run keeps the previous branch data', () => {
        status.writeMainSyncStatus(root, entry('dean/x'));
        status.recordRefreshOutcome(root, 555, RefreshOutcome.ERROR);
        const file = status.readMainSyncStatusFile(root);
        expect(file?.lastRefreshStartedMs).toBe(555);
        expect(file?.lastRefreshOutcome).toBe(RefreshOutcome.ERROR);
        expect(status.readMainSyncStatus(root, 'dean/x')).not.toBeNull();
    });

    it('pr-gate`s single-branch write does not erase the stamp', () => {
        stampRefresh(777);
        status.writeMainSyncStatus(root, entry('dean/y'));
        expect(status.readMainSyncStatusFile(root)?.lastRefreshStartedMs).toBe(777);
    });
});
