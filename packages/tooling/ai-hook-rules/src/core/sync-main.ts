import {
    BranchReaper,
    DEFAULT_HANG_TIMEOUT_MINUTES,
    MainSyncStatusFile,
    MergedBranchesCache,
    MergedBranchesService,
    ReapResult,
    loadAndValidate,
    computeAllMainSyncStatuses,
    writeMainSyncStatusFile,
    writeMainSyncLock,
    tryAcquireMainSyncLock,
    finishedLock,
} from '@webpieces/rules-config';

import { toError } from './to-error';
import { logSyncEvent, SyncLogEvent } from './main-sync-log';
import { logStream, StreamIdentity } from './log-stream';

/**
 * The detached, fire-and-forget refresher spawned (by file path, not a bin) from
 * main-sync-refresh.ts. It does the SLOW work (merged-PR lookup + git fetch + merge-base +
 * same-file-overlap) and writes `.webpieces/main-sync-status.json` so the next hook call reads it
 * instantly. Nobody reads our exit code or output — we run after the spawning hook has returned.
 *
 * Concurrency: a lock file (`.webpieces/main-sync.lock.json`) holds `inprocess`/`finished` + a start
 * epoch + the holder's pid, taken with an ATOMIC exclusive create. If another refresher already holds
 * it and is alive, we exit immediately (don't pile up `git fetch`es). If the holder is finished, dead,
 * or older than hangTimeoutMinutes, the lock is reclaimed and we proceed.
 *
 * argv: [, , repoRoot, hangTimeoutMinutes, sessionId, agentId, hook]
 *
 * The last three are the SPAWNER's LogStream identity, and adopting them here is the whole reason
 * they are passed. This process has its own fresh module-level `logStream`; left unidentified it
 * named every line `unknown-coordinator-hook.log` — one shared file that every
 * agent's refresher child appended to concurrently (the PIPE_BUF tearing LogStream exists to remove),
 * and which held this run's START/FINISH while the parent's SPAWN_ATTEMPT sat in a different file
 * entirely. Adopting the parent's identity puts one refresh cycle back in one stream. Absent argv
 * (a hand-run of this file) leaves the default, which still prefixes.
 */
export function main(): void {
    logStream.identify(spawnerIdentity(process.argv));
    refreshMainSync(
        process.argv[2] ?? process.cwd(),
        hangTimeoutFromArgv(process.argv[3]),
        process.argv.slice(2).join(' '),
    );
}

/**
 * Parse the hang timeout off argv, WITHOUT `||`.
 *
 * `Number(argv[3]) || DEFAULT` silently rewrote a configured `0` — "never treat a lock as stale" — into
 * the 5-minute default, because `0` is falsy. The knob now has exactly one reader (the branch-state
 * policy entry), so a value that survives the config only to be discarded at the process boundary is
 * the whole knob being a lie. Only a MISSING or non-numeric argument falls back.
 */
// webpieces-disable no-function-outside-class -- argv parse for this detached main(), matching the file's existing shape
export function hangTimeoutFromArgv(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_HANG_TIMEOUT_MINUTES;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_HANG_TIMEOUT_MINUTES;
}

/**
 * The spawner's LogStream identity as it arrives on this child's argv — positions 4/5/6, which is
 * where `triggerMainSyncRefresh` puts them (its own array is offset by two: node + script path).
 *
 * Exported so ONE test can pin BOTH ends of the contract at once. The bug this closes is precisely a
 * disagreement between two files about argv positions, and a test that only checks the reader would
 * have stayed green through it.
 */
// webpieces-disable no-function-outside-class -- argv parse for this detached main(), matching the file's existing shape
export function spawnerIdentity(argv: string[]): StreamIdentity {
    return new StreamIdentity(argv[4] ?? '', argv[5] ?? '', argv[6] ?? 'hook');
}

/**
 * The refresh itself, argv-free so it can be driven by a test. `main()` is only the argv parse — a
 * test importing another module's `main` is what no-process-exit-outside-main exists to prevent.
 */
// webpieces-disable no-function-outside-class -- module-level entry point of this detached refresher, matching the file's existing shape
export function refreshMainSync(repoRoot: string, hangTimeoutMinutes: number, argvDetail: string = ''): void {
    const startedMs = Date.now();

    // First action: prove the detached child actually started. If the async-refresh stream has no START line
    // for a spawn, the child never launched (or died before this point).
    logSyncEvent(repoRoot, new SyncLogEvent('START', process.pid, '-', `argv=${argvDetail}`));

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // ONE atomic acquire — not a check followed by a write. The old check-then-write pair had a
        // gap in which two detached children could both pass the check and then both run `git fetch`.
        const lock = tryAcquireMainSyncLock(repoRoot, hangTimeoutMinutes);
        if (!lock) {
            logSyncEvent(repoRoot, new SyncLogEvent('SKIP_INPROGRESS', process.pid, '-', 'another refresh is in progress'));
            return;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // EVERY worktree's branch, not just ours. The cache is shared by the whole repo but used
            // to describe only the branch of whichever tree won this lock, so every other worktree's
            // guards read a cross-branch cache and abstained. One fetch + one `gh` call now arms all
            // of them; the map is rebuilt from the live worktree set, so dead branches drop out.
            const file = computeAllMainSyncStatuses(repoRoot);
            writeMainSyncStatusFile(repoRoot, file);

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
            const names = Object.keys(file.branches);
            logSyncEvent(repoRoot, new SyncLogEvent(
                'FINISH', process.pid, names.join(','),
                `branches=${String(names.length)} ${names.map(summarize(file)).join(' ')} deletableBranches=${String(cache.deletable.length)} reaped=${String(reaped)} ms=${String(Date.now() - startedMs)}`,
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
 * One `branch(merged/forkPoint/conflict)` token per recorded branch, for the FINISH log line. The log
 * is the only evidence that a given worktree's branch was actually armed by a refresh, so it has to
 * name every branch written, not just the tree the refresher happened to run in.
 */
// webpieces-disable no-function-outside-class -- module-level log formatter of this detached main(), matching the file's existing shape
function summarize(file: MainSyncStatusFile): (branch: string) => string {
    return (branch: string): string => {
        const status = file.branches[branch];
        if (status === undefined) return `${branch}(?)`;
        return `${branch}(merged=${String(status.branchAlreadyMerged)}:${status.mergedPr} fork=${String(status.hasForkPoint)} conflict=${String(status.conflict)})`;
    };
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
