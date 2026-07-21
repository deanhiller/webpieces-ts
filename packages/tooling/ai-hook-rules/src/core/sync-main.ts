import {
    BranchReaper,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    MergedBranchesCache,
    MergedBranchesService,
    ReapResult,
    loadAndValidate,
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

            // Third step, same detached run: actually DELETE the dead branches. Reporting them was
            // never enough — the reap was only ever a `git branch -D` string in a fix hint, which an
            // agent reads as destructive and stalls on, so nothing was ever cleaned. Here nobody has
            // to be asked. Reuses the verdicts we JUST computed (no second `gh` call).
            const reaped = autoReap(repoRoot, cache);

            // FINISH after a successful write — START-without-FINISH means we were killed mid-run.
            logSyncEvent(repoRoot, new SyncLogEvent(
                'FINISH', process.pid, status.branch,
                `merged=${String(status.branchAlreadyMerged)} mergedPr=${status.mergedPr} forkPoint=${String(status.hasForkPoint)} conflict=${String(status.conflict)} deletableBranches=${String(cache.deletable.length)} reaped=${String(reaped)} ms=${String(Date.now() - startedMs)}`,
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

/**
 * Delete the branches the verdicts just declared dead. Returns how many actually went.
 *
 * WHY it is safe to do this unattended: every candidate is provably dead (merged PR / squash backup
 * of a merged branch / zero commits of its own), `main` and any worktree-held branch are excluded
 * upstream, and each delete is logged with the branch's pre-delete SHA plus the exact command that
 * restores it. WHY it is safe to do it HERE: this refresher already recomputed those verdicts on
 * this very run, so it is acting on evidence seconds old, not on the deliberately-stale cache file.
 *
 * Swallows everything. We are detached and fire-and-forget: cleanup failing must never damage the
 * main-sync status this process exists to produce — but every failure is logged, because a silent
 * background deletion is exactly what nobody should have to trust.
 */
// webpieces-disable no-function-outside-class -- module-level helper of this detached main(), matching the file's existing shape
function autoReap(repoRoot: string, cache: MergedBranchesCache): number {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const config = loadAndValidate(repoRoot).rulesConfig['branch-creation-guard'];
        // Strictly opt-IN: only an explicit `true` reaps. `autoReapMergedBranches` is schema-required,
        // so every validated config states an answer — which means "absent" here is not a consumer
        // who wants the default, it is a config that never passed validation. Deleting branches on
        // that basis would be deleting on a preference nobody expressed.
        if (config?.mode === 'OFF' || config?.autoReapMergedBranches !== true) return 0;

        const result: ReapResult = new BranchReaper().reap(repoRoot, 'auto-reap', cache);
        for (const failure of result.failed) {
            logSyncEvent(repoRoot, new SyncLogEvent(
                'ERROR', process.pid, failure.branch, `reap failed: ${failure.error}`));
        }
        return result.reaped.length;
    } catch (err: unknown) {
        const error = toError(err);
        logSyncEvent(repoRoot, new SyncLogEvent('ERROR', process.pid, '-', `autoReap: ${error.message}`));
        return 0;
    }
}

if (require.main === module) {
    main();
}
