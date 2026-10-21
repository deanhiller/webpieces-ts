import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { AtomicFile, DotWebpieces, dotWebpieces } from '@webpieces/tooling-common';
import { toError } from '@webpieces/tooling-common/to-error';
import { MainSyncStatusService } from './main-sync-status';

/**
 * The fewest minutes between two refresher STARTS, repo-wide (#1342).
 *
 * The refresh feeds only main-staleness (commits behind) and the merged-PR/reap data, and neither
 * needs minute-level freshness: every `wp-*` command that acts on main does its own fetch. Without a
 * floor the guards started a full refresh (`git fetch` over ssh, `gh pr list --limit 200`, per-branch
 * merge-base) roughly once a minute per repo, and launched a node child on every single tool call.
 *
 * A CONSTANT, not a config knob: it only tunes frequency, and a key would have to wait a release
 * before this repo's own config could state it (the published validator is one release behind).
 */
export const MIN_REFRESH_INTERVAL_MINUTES = 10;

/**
 * The pid a SPAWNER writes into the lock it takes for a refresher it has not launched yet. The hook
 * process that wins exits within milliseconds, so its own pid would read as "holder dead" and invite a
 * reclaim; 0 reads as "holder unknown", which is judged by age alone and is never signalled. The child
 * replaces it with its own pid the moment it starts (adoptMainSyncLock).
 */
export const SPAWNER_CLAIM_PID = 0;

const MAIN_SYNC_LOCK_FILE = 'main-sync.lock.json';

export const MAIN_SYNC_LOCK_PURPOSE =
    'Created atomically (O_EXCL) to award ONE process the right to run the main-sync refresh. The winner '
    + 'deletes it when done; a lock older than hangTimeoutMinutes, or whose pid is dead, is reclaimed '
    + '(its holder killed). Results live in main-sync-status.json, never here.';

/**
 * The WHOLE content of `main-sync.lock.json` (data only). The file is a mutex and nothing else: its
 * EXISTENCE is the lock. `pid` serves the liveness check, the kill of a hung holder and the "is it
 * still mine" check before delete; `startedMs` serves the hangTimeoutMinutes staleness check. No state,
 * no results: those are in main-sync-status.json, written before this file is deleted.
 */
export class MainSyncLock {
    purpose: string;
    pid: number;
    startedMs: number;

    constructor(pid: number, startedMs: number) {
        this.purpose = MAIN_SYNC_LOCK_PURPOSE;
        this.pid = pid;
        this.startedMs = startedMs;
    }
}

/** Why a spawner did, or did not, win the right to launch a refresher. */
export enum RefreshClaimOutcome {
    /** This caller created the lock and must launch the refresher (which adopts it). */
    CLAIMED = 'claimed',
    /** The last refresh STARTED less than MIN_REFRESH_INTERVAL_MINUTES ago. Nothing to do. */
    RECENT = 'recent',
    /** The lock exists and its holder is running, or another caller won the create first. */
    HELD = 'held',
}

// Data-only result of MainSyncLockService.claimRefresh (per CLAUDE.md: classes for data).
export class RefreshClaim {
    outcome: RefreshClaimOutcome;
    /** The lock now held; set only for CLAIMED. */
    lock: MainSyncLock | null;
    /** The stamp this decision read from main-sync-status.json, or null when none was recorded. */
    lastRefreshStartedMs: number | null;

    constructor(outcome: RefreshClaimOutcome, lock: MainSyncLock | null, lastRefreshStartedMs: number | null) {
        this.outcome = outcome;
        this.lock = lock;
        this.lastRefreshStartedMs = lastRefreshStartedMs;
    }
}

// Raw JSON shape for the cast at the parse boundary.
// Every field optional: the runtime `typeof` checks in readMainSyncLock are what decide it is a lock.
interface RawLock {
    purpose?: string;
    pid?: number;
    startedMs?: number;
}

/**
 * The single-flight mutex for the detached main-sync refresher, and the spawner's throttle in front of
 * it (#1342). Two files, two jobs:
 *
 *   - `main-sync.lock.json` — the MUTEX. Created with an atomic exclusive create; the creator runs the
 *     refresh and deletes it when done, after confirming it is still its own. Everybody else gets
 *     EEXIST and skips.
 *   - `main-sync-status.json` — the RESULTS, and `lastRefreshStartedMs`, the throttle's stamp. The
 *     refresher writes it FIRST and deletes the lock LAST, so the stamp is on disk before any process
 *     can win the next race.
 *
 * SHARED scope: one lock for the whole repo, in the primary clone. There is one `.git`, and N
 * concurrent `git fetch`es against it are what corrupt `.git/FETCH_HEAD`.
 */
@injectable(bindingScopeValues.Singleton)
export class MainSyncLockService {
    constructor(
        private readonly dotDir: DotWebpieces = dotWebpieces,
        private readonly atomicFile: AtomicFile = new AtomicFile(),
        private readonly status: MainSyncStatusService = new MainSyncStatusService(),
    ) {}

    mainSyncLockPath(repoRoot: string): string {
        return this.dotDir.sharedFile(repoRoot, MAIN_SYNC_LOCK_FILE);
    }

    /**
     * THE SPAWNER'S WHOLE DECISION: may this hook process launch a refresher? Called BEFORE anything
     * is spawned, so a throttled tool call costs one read of the status file: no node child, no git.
     *
     * The stamp is the last run's START, and a failed run records one too, so a failing refresh
     * (offline, gh auth expired) is retried after the interval: never hammered on every call, never
     * blocked forever. A run that crashes before recording anything leaves its lock behind, and that
     * lock is reclaimed once older than `hangTimeoutMinutes`.
     */
    claimRefresh(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now()): RefreshClaim {
        const file = this.status.readMainSyncStatusFile(repoRoot);
        const stamp = file === null ? null : file.lastRefreshStartedMs;
        if (stamp !== null && this.withinInterval(stamp, now)) {
            return new RefreshClaim(RefreshClaimOutcome.RECENT, null, stamp);
        }
        const lock = this.tryAcquireMainSyncLock(repoRoot, hangTimeoutMinutes, now, SPAWNER_CLAIM_PID);
        return new RefreshClaim(lock === null ? RefreshClaimOutcome.HELD : RefreshClaimOutcome.CLAIMED, lock, stamp);
    }

    /**
     * Take the mutex with an atomic exclusive create. Returns the lock now held, or null.
     *
     * Normal case: the file does not exist (the last winner deleted it), the create wins, done. On
     * EEXIST the holder is judged: alive and inside `hangTimeoutMinutes` means it is working, and we
     * skip. Otherwise (hung, dead, or a file that is not a lock in this shape at all, such as the
     * retired `state: finished` format) it is the ONE exception to "the winner deletes": its holder is
     * killed if still alive, the file unlinked, and the create retried once; only that create's winner
     * proceeds.
     *
     * The create writes the content to a private temp file and LINKS it into place: `link()` fails with
     * EEXIST exactly like O_EXCL, but the lock appears with its content already in it, so no reader can
     * ever see an empty lock and mistake it for garbage.
     */
    tryAcquireMainSyncLock(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now(), pid: number = process.pid): MainSyncLock | null {
        const mine = new MainSyncLock(pid, now);
        if (this.createExclusive(repoRoot, mine)) return mine;

        const held = this.readMainSyncLock(repoRoot);
        if (held !== null && this.isHolderRunning(held, hangTimeoutMinutes, now)) return null;
        if (held !== null) {
            this.killStaleHolder(held, pid);
            // Unlink only the lock we judged. A contender that reclaimed first has already created a
            // FRESH lock here, and that one is not ours to remove.
            const again = this.readMainSyncLock(repoRoot);
            if (again !== null && (again.pid !== held.pid || again.startedMs !== held.startedMs)) return null;
            fs.rmSync(this.mainSyncLockPath(repoRoot), { force: true });
        }
        return this.createExclusive(repoRoot, mine) ? mine : null;
    }

    /**
     * The detached refresher takes over the lock its spawner created: same `startedMs`, its own pid, so
     * liveness and the reclaimer's kill now target the process doing the work. Null when that lock is no
     * longer on disk (it was reclaimed while the child booted); the child then does nothing. The child
     * never creates the lock itself, so it can never race its own spawner.
     */
    adoptMainSyncLock(repoRoot: string, claimStartedMs: number, pid: number = process.pid): MainSyncLock | null {
        const held = this.readMainSyncLock(repoRoot);
        if (held === null || held.startedMs !== claimStartedMs || held.pid !== SPAWNER_CLAIM_PID) return null;
        const adopted = new MainSyncLock(pid, claimStartedMs);
        this.writeMainSyncLock(repoRoot, adopted);
        return adopted;
    }

    /**
     * Delete OUR lock. Returns false, and deletes nothing, when the lock on disk is not ours: a run that
     * hung past its window was reclaimed, and deleting the NEWER holder's lock would let a third
     * refresher start beside the second. Call it only after the status file (and its stamp) is written.
     */
    releaseMainSyncLock(repoRoot: string, held: MainSyncLock): boolean {
        const onDisk = this.readMainSyncLock(repoRoot);
        if (onDisk === null || onDisk.pid !== held.pid || onDisk.startedMs !== held.startedMs) return false;
        fs.rmSync(this.mainSyncLockPath(repoRoot), { force: true });
        return true;
    }

    /**
     * The lock on disk, or null when there is none. A file that is not a lock in this shape (the retired
     * `state`/`started` format, or anything unparseable) reads as a lock with pid 0 started at the epoch:
     * stale at once, so it is reclaimed rather than honoured as a second spelling of a lock.
     */
    readMainSyncLock(repoRoot: string): MainSyncLock | null {
        const text = this.readText(this.mainSyncLockPath(repoRoot));
        if (text === null) return null;
        const raw = this.parse(text);
        if (raw === null || raw.purpose !== MAIN_SYNC_LOCK_PURPOSE) return new MainSyncLock(0, 0);
        if (typeof raw.pid !== 'number' || typeof raw.startedMs !== 'number') return new MainSyncLock(0, 0);
        return new MainSyncLock(raw.pid, raw.startedMs);
    }

    // Replace the lock's content atomically (temp + rename). Only for a lock this process already holds.
    writeMainSyncLock(repoRoot: string, lock: MainSyncLock): void {
        this.atomicFile.writeJsonAtomic(this.mainSyncLockPath(repoRoot), lock);
    }

    // True when a refresher holds the lock and is working: alive, and inside its hang window.
    isRefreshInProgress(repoRoot: string, hangTimeoutMinutes: number, now: number = Date.now()): boolean {
        const lock = this.readMainSyncLock(repoRoot);
        return lock !== null && this.isHolderRunning(lock, hangTimeoutMinutes, now);
    }

    // A lock is stale (its holder assumed hung) once older than hangTimeoutMinutes.
    isLockStale(lock: MainSyncLock, hangTimeoutMinutes: number, now: number = Date.now()): boolean {
        return now - lock.startedMs > hangTimeoutMinutes * 60 * 1000;
    }

    // pid 0 = unknown (a spawner's unadopted lock) → alive, judged by age alone.
    private isHolderRunning(lock: MainSyncLock, hangTimeoutMinutes: number, now: number): boolean {
        return !this.isLockStale(lock, hangTimeoutMinutes, now) && this.isProcessAlive(lock.pid);
    }

    // A negative age (the clock stepped backwards) never throttles: it would otherwise pin the stamp.
    private withinInterval(startedMs: number, now: number): boolean {
        const age = now - startedMs;
        return age >= 0 && age < MIN_REFRESH_INTERVAL_MINUTES * 60 * 1000;
    }

    // The file's text, or null when there is no lock (including one deleted between check and read).
    private readText(lockPath: string): string | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return fs.readFileSync(lockPath, 'utf8');
        } catch (err: unknown) {
            const error = toError(err);
            if (error.message.includes('ENOENT')) return null;
            throw error;
        }
    }

    private parse(text: string): RawLock | null {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const parsed = JSON.parse(text) as RawLock | null;
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (err: unknown) { // webpieces-disable catch-must-propagate -- an unparseable lock IS the answer here: it is garbage, and the caller reclaims it
            const error = toError(err);
            void error;
            return null;
        }
    }

    /**
     * Atomic create-with-content: write a private temp file, then `link()` it to the lock path. The link
     * fails with EEXIST when the lock exists, which is the O_EXCL contract, and a reader never sees the
     * lock before its content.
     */
    private createExclusive(repoRoot: string, lock: MainSyncLock): boolean {
        const lockPath = this.mainSyncLockPath(repoRoot);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const tmp = `${lockPath}.${String(process.pid)}.${String(Date.now())}.${Math.random().toString(36).slice(2)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            fs.linkSync(tmp, lockPath);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error.message.includes('EEXIST')) return false;
            throw error;
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    }

    /**
     * Best-effort SIGKILL of a reclaimed holder that is still alive: a refresher hung past
     * `hangTimeoutMinutes`. Never for pid <= 0 (a spawner's unadopted lock, or garbage), our own pid,
     * or the claimant's. The refresher is spawned `detached`, so it leads its own process group: the
     * group is signalled first, which takes its in-flight `git fetch` / `gh` children with it; a plain
     * pid signal is the fallback for a holder that is not a group leader.
     *
     * Residual risk, accepted: after a long hang the OS may have reused the pid. The window is
     * hangTimeoutMinutes, and pids cycle far slower than that on a developer machine.
     */
    private killStaleHolder(stale: MainSyncLock, claimantPid: number): void {
        if (stale.pid <= 0 || stale.pid === process.pid || stale.pid === claimantPid) return;
        if (!this.isProcessAlive(stale.pid)) return;
        if (this.sendKill(-stale.pid)) return;
        this.sendKill(stale.pid);
    }

    // true when delivered; false for no such process/group (ESRCH) or not ours to signal (EPERM).
    private sendKill(target: number): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            process.kill(target, 'SIGKILL');
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error.message.includes('ESRCH') || error.message.includes('EPERM')) return false;
            throw error;
        }
    }

    // Liveness probe: is `pid` still a running process? pid <= 0 (unknown) → assume alive.
    private isProcessAlive(pid: number): boolean {
        if (pid <= 0) return true;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            process.kill(pid, 0);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            if (error.message.includes('ESRCH')) return false;
            if (error.message.includes('EPERM')) return true;
            throw error;
        }
    }
}
