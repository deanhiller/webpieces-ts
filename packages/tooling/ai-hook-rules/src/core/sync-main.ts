import {
    DEFAULT_HANG_TIMEOUT_MINUTES,
    computeMainSyncStatus,
    writeMainSyncStatus,
    writeMainSyncLock,
    isRefreshInProgress,
    inProcessLock,
    finishedLock,
} from '@webpieces/rules-config';

import { toError } from './to-error';

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

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        if (isRefreshInProgress(repoRoot, hangTimeoutMinutes)) return;

        const lock = inProcessLock();
        writeMainSyncLock(repoRoot, lock);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const status = computeMainSyncStatus(repoRoot);
            writeMainSyncStatus(repoRoot, status);
        } finally {
            // Always flip the lock off so a compute failure can't wedge the guard until the
            // staleness reclaim kicks in.
            writeMainSyncLock(repoRoot, finishedLock(lock.started));
        }
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        // Detached: swallow so a transient git/fs error never leaves poison state. The next hook
        // call spawns a fresh refresher.
    }
}

if (require.main === module) {
    main();
}
