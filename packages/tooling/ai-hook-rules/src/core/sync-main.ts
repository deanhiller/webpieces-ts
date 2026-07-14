import {
    DEFAULT_HANG_TIMEOUT_MINUTES,
    MergedBranchesService,
    computeMainSyncStatus,
    writeMainSyncStatus,
    writeMainSyncLock,
    isRefreshInProgress,
    inProcessLock,
    finishedLock,
} from '@webpieces/rules-config';

import { toError } from './to-error';
import { logSyncEvent, SyncLogEvent } from './main-sync-log';

/**
 * The detached, fire-and-forget refresher spawned (by file path, not a bin) from
 * main-sync-refresh.ts. It does the SLOW work (merged-PR lookup + git fetch + merge-base +
 * same-file-overlap) and writes `.webpieces/main-sync-status.json` so the next hook call reads it
 * instantly. Nobody reads our exit code or output — we run after the spawning hook has returned.
 *
 * Concurrency: a lock file (`.webpieces/main-sync.lock.json`) holds `inprocess`/`finished` + a start
 * epoch. If another refresher is already `inprocess` and younger than hangTimeoutMinutes, we exit
 * immediately (don't pile up `git fetch`es). If it's `inprocess` but older than hangTimeoutMinutes,
 * we assume it hung and proceed anyway.
 *
 * argv: [, , repoRoot, hangTimeoutMinutes]
 */
export function main(): void {
    const repoRoot = process.argv[2] ?? process.cwd();
    const hangTimeoutMinutes = Number(process.argv[3]) || DEFAULT_HANG_TIMEOUT_MINUTES;
    const startedMs = Date.now();

    // First action: prove the detached child actually started. If guard-async-work.log has no START line
    // for a spawn, the child never launched (or died before this point).
    logSyncEvent(repoRoot, new SyncLogEvent('START', process.pid, '-', `argv=${process.argv.slice(2).join(' ')}`));

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        if (isRefreshInProgress(repoRoot, hangTimeoutMinutes)) {
            logSyncEvent(repoRoot, new SyncLogEvent('SKIP_INPROGRESS', process.pid, '-', 'another refresh is in progress'));
            return;
        }

        const lock = inProcessLock();
        writeMainSyncLock(repoRoot, lock);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const status = computeMainSyncStatus(repoRoot);
            writeMainSyncStatus(repoRoot, status);

            // Second slow signal, same lock, same detached run: which local branches are dead. One bulk
            // `gh pr list --state merged` call. The branch-creation-guard reads the result to enforce its
            // cap without ever touching the network itself. Deliberately allowed to go stale.
            const mergedBranches = new MergedBranchesService();
            const cache = mergedBranches.computeMergedBranches(repoRoot);
            mergedBranches.writeMergedBranches(repoRoot, cache);

            // FINISH after a successful write — START-without-FINISH means we were killed mid-run.
            logSyncEvent(repoRoot, new SyncLogEvent(
                'FINISH', process.pid, status.branch,
                `merged=${String(status.branchAlreadyMerged)} mergedPr=${status.mergedPr} forkPoint=${String(status.hasForkPoint)} conflict=${String(status.conflict)} deletableBranches=${String(cache.deletable.length)} ms=${String(Date.now() - startedMs)}`,
            ));
        } finally {
            // Always flip the lock off so a compute failure can't wedge the guard until the
            // staleness reclaim kicks in.
            writeMainSyncLock(repoRoot, finishedLock(lock.started));
        }
    } catch (err: unknown) {
        const error = toError(err);
        // Detached: swallow so a transient git/fs error never leaves poison state (the next hook call
        // spawns a fresh refresher) — but record WHY it died so the failure isn't invisible.
        logSyncEvent(repoRoot, new SyncLogEvent('ERROR', process.pid, '-', `${error.message} | ${error.stack ?? ''}`));
    }
}

if (require.main === module) {
    main();
}
