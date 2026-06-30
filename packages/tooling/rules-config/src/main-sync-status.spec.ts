import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    MainSyncStatus,
    MainSyncLock,
    readMainSyncStatus,
    writeMainSyncStatus,
    writeMainSyncLock,
    isLockStale,
    isRefreshInProgress,
    inProcessLock,
    finishedLock,
    computeMainSyncStatus,
    squashRecoverySteps,
} from './main-sync-status';

function tmpRepoRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mss-'));
}

describe('main-sync lock state machine', () => {
    let root: string;
    beforeEach(() => { root = tmpRepoRoot(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('isLockStale: inprocess older than hangTimeoutMinutes is stale', () => {
        const now = 10 * 60 * 1000;
        const fresh = new MainSyncLock('inprocess', now - 2 * 60 * 1000);
        const old = new MainSyncLock('inprocess', now - 6 * 60 * 1000);
        expect(isLockStale(fresh, 5, now)).toBe(false);
        expect(isLockStale(old, 5, now)).toBe(true);
    });

    it('isRefreshInProgress: false when no lock, finished, or stale; true only for a fresh inprocess lock', () => {
        const now = 10 * 60 * 1000;
        expect(isRefreshInProgress(root, 5, now)).toBe(false); // no lock

        writeMainSyncLock(root, finishedLock(now));
        expect(isRefreshInProgress(root, 5, now)).toBe(false); // finished

        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000));
        expect(isRefreshInProgress(root, 5, now)).toBe(true); // fresh inprocess

        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 6 * 60 * 1000));
        expect(isRefreshInProgress(root, 5, now)).toBe(false); // hung → reclaimable
    });

    it('isRefreshInProgress: a fresh inprocess lock whose refresher pid is dead is reclaimable', () => {
        const now = 10 * 60 * 1000;
        // Fresh (not stale) but owned by a pid that cannot exist → a killed refresher → reclaimable
        // immediately, NOT wedged until hangTimeout.
        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, 2147483646));
        expect(isRefreshInProgress(root, 5, now)).toBe(false);
        // Fresh inprocess owned by THIS live process → genuinely in progress.
        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, process.pid));
        expect(isRefreshInProgress(root, 5, now)).toBe(true);
        // pid 0 (an old lock without a pid) → fall back to staleness only → still in progress.
        writeMainSyncLock(root, new MainSyncLock('inprocess', now - 60 * 1000, 0));
        expect(isRefreshInProgress(root, 5, now)).toBe(true);
    });

    it('inProcessLock/finishedLock build the expected states', () => {
        expect(inProcessLock(123).state).toBe('inprocess');
        expect(inProcessLock(123).started).toBe(123);
        expect(inProcessLock(123).pid).toBe(process.pid);
        expect(finishedLock(123).state).toBe('finished');
    });
});

describe('main-sync status IO', () => {
    let root: string;
    beforeEach(() => { root = tmpRepoRoot(); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('round-trips a status', () => {
        const status = new MainSyncStatus('dean/x', false, '', true, 'aaa', 'bbb', 'ccc', true, ['p/q.ts'], '2026-06-30T00:00:00.000Z');
        writeMainSyncStatus(root, status);
        const read = readMainSyncStatus(root);
        expect(read).not.toBeNull();
        expect(read?.conflict).toBe(true);
        expect(read?.conflictFiles).toEqual(['p/q.ts']);
        expect(read?.hasForkPoint).toBe(true);
        expect(read?.branch).toBe('dean/x');
        expect(read?.branchAlreadyMerged).toBe(false);
    });

    it('round-trips branchAlreadyMerged + mergedPr', () => {
        const status = new MainSyncStatus('dean/x', true, '42', true, 'aaa', 'bbb', 'ccc', false, [], 'ts');
        writeMainSyncStatus(root, status);
        const read = readMainSyncStatus(root);
        expect(read?.branchAlreadyMerged).toBe(true);
        expect(read?.mergedPr).toBe('42');
    });

    it('returns null for a missing file', () => {
        expect(readMainSyncStatus(root)).toBeNull();
    });

    it('returns null for malformed JSON (fail-open)', () => {
        fs.mkdirSync(path.join(root, '.webpieces'), { recursive: true });
        fs.writeFileSync(path.join(root, '.webpieces', 'main-sync-status.json'), '{ not json');
        expect(readMainSyncStatus(root)).toBeNull();
    });
});

describe('squashRecoverySteps', () => {
    it('names the current branch in the new-branch and squash-source steps', () => {
        const steps = squashRecoverySteps('dean/foo').join('\n');
        expect(steps).toContain('dean/foo-v2');
        expect(steps).toContain('git merge --squash dean/foo');
    });
});

// Integration helpers (module scope to keep the describe callback under the method-line limit).
function git(repo: string, cmd: string): void {
    execSync(`git ${cmd}`, { cwd: repo, stdio: 'pipe' });
}

// Build a repo whose feature branch and main both diverge from a common base, then publish main as
// origin/main (no real remote — computeMainSyncStatus only needs the ref to resolve; its `git fetch`
// is best-effort and ignored). `mainEdits`/`featureEdits` are the files each side rewrites.
function buildRepo(work: string, mainEdits: string[], featureEdits: string[]): void {
    git(work, 'init');
    git(work, 'config core.hooksPath /dev/null'); // neutralize any global pre-commit hooks
    git(work, 'config user.email t@t.t');
    git(work, 'config user.name t');
    git(work, 'config commit.gpgsign false');
    fs.writeFileSync(path.join(work, 'shared.txt'), 'base\n');
    fs.writeFileSync(path.join(work, 'other.txt'), 'base\n');
    git(work, 'add -A');
    git(work, 'commit -m base');
    git(work, 'branch -M main');

    git(work, 'checkout -b feature');
    for (const f of featureEdits) fs.writeFileSync(path.join(work, f), 'feature change\n');
    git(work, 'add -A');
    git(work, 'commit -m feature');

    git(work, 'checkout main');
    for (const f of mainEdits) fs.writeFileSync(path.join(work, f), 'main change\n');
    git(work, 'add -A');
    git(work, 'commit -m mainchange');
    git(work, 'update-ref refs/remotes/origin/main refs/heads/main');

    git(work, 'checkout feature');
}

describe('computeMainSyncStatus (integration)', () => {
    let work: string;

    beforeEach(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-work-'));
    });

    afterEach(() => {
        fs.rmSync(work, { recursive: true, force: true });
    });

    it('records the REAL checked-out branch (not an env var)', () => {
        // Set a misleading env var: the old getCurrentBranch would have returned it; gitBranch must not.
        const prev = process.env['GIT_BRANCH'];
        process.env['GIT_BRANCH'] = 'main';
        buildRepo(work, ['other.txt'], ['shared.txt']);
        const status = computeMainSyncStatus(work);
        if (prev === undefined) delete process.env['GIT_BRANCH']; else process.env['GIT_BRANCH'] = prev;
        expect(status.branch).toBe('feature');
    });

    it('flags conflict=true when main and the branch touched the same file', () => {
        buildRepo(work, ['shared.txt'], ['shared.txt']);
        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(true);
        expect(status.conflictFiles).toContain('shared.txt');
    });

    it('flags conflict=false when main and the branch touched different files', () => {
        buildRepo(work, ['shared.txt'], ['other.txt']);
        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(true);
        expect(status.conflict).toBe(false);
    });

    it('flags hasForkPoint=false when origin/main has no merge-base with the branch', () => {
        // An orphan commit shares no history with the branch — simulates the "main got merged /
        // history rewritten so there is no common ancestor" case the guard forces a human to fix.
        buildRepo(work, ['shared.txt'], ['other.txt']);
        git(work, 'checkout --orphan orphanbranch');
        fs.writeFileSync(path.join(work, 'z.txt'), 'orphan\n');
        git(work, 'add -A');
        git(work, 'commit -m orphan');
        git(work, 'update-ref refs/remotes/origin/main refs/heads/orphanbranch');
        git(work, 'checkout feature');

        const status = computeMainSyncStatus(work);
        expect(status.hasForkPoint).toBe(false);
        expect(status.forkPoint).toBeNull();
    });
});
