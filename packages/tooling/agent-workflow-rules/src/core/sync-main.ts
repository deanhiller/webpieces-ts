import { BranchCreationGuardConfig } from '../configs/rule-configs';
import { BranchReaper, MainSyncLockService, MainSyncStatusFile, MainSyncStatusService, MergedBranchesCache, MergedBranchesService, ReapResult, RefreshOutcome } from '@webpieces/repo-workflow-core';
import { loadAndValidate, runMain } from '@webpieces/rules-config';

import { toError } from '@webpieces/tooling-common/to-error';
import { logSyncEvent, SyncLogEvent } from './main-sync-log';
import { logStream, StreamIdentity } from './log-stream';

// The services this detached process writes its results through, and adopts and deletes its lock through.
const status = new MainSyncStatusService();
const locks = new MainSyncLockService(undefined, undefined, status);

/**
 * The detached, fire-and-forget refresher spawned (by file path, not a bin) from
 * main-sync-refresh.ts. It does the SLOW work (merged-PR lookup + git fetch + merge-base +
 * same-file-overlap) and writes `.webpieces/main-sync-status.json` so the next hook call reads it
 * instantly. Nobody reads our exit code or output — we run after the spawning hook has returned.
 *
 * Concurrency: `.webpieces/main-sync.lock.json` is a mutex whose EXISTENCE is the lock (it holds only
 * the holder's pid and start epoch). The SPAWNER creates it exclusively (main-sync-refresh.ts →
 * claimRefresh), only once MIN_REFRESH_INTERVAL_MINUTES have passed since the last start (at once for a
 * branch the status file has never seen, #1377), and passes
 * its `startedMs` on argv. This child ADOPTS that lock (rewriting the pid to its own) and never creates
 * one itself, so it cannot race its spawner. A lock that is no longer on disk (reclaimed while this
 * child booted) means another refresher owns the run, and we exit.
 *
 * Ordering at the end is the point: the status file, carrying `lastRefreshStartedMs` and the outcome,
 * is written FIRST and the lock deleted LAST, so no process can win the next lock race and still read
 * the previous stamp.
 *
 * argv: [, , repoRoot, claimStarted, sessionId, agentId, hook]
 *
 * The last three are the SPAWNER's LogStream identity, and adopting them here is the whole reason
 * they are passed. This process has its own fresh module-level `logStream`; left unidentified it
 * named every line `unknown-coordinator-hook.log` — one shared file that every
 * agent's refresher child appended to concurrently (the PIPE_BUF tearing LogStream exists to remove),
 * and which held this run's START/FINISH while the parent's SPAWN_ATTEMPT sat in a different file
 * entirely. Adopting the parent's identity puts one refresh cycle back in one stream. Absent argv
 * (a hand-run of this file) leaves the default, which still prefixes.
 */
// webpieces-disable no-function-outside-class -- existing stateless module helper moved intact with its callers; ownership extraction preserves its functional API
export async function main(): Promise<void> {
    logStream.identify(spawnerIdentity(process.argv));
    await refreshMainSync(
        process.argv[2] ?? process.cwd(),
        claimStartedFromArgv(process.argv),
        process.argv.slice(2).join(' '),
    );
}

/**
 * The `started` of the lock claim the spawner took for this run — argv position 3, which is
 * `refresherArgv`'s 2 (see the offset note there). NaN when absent or malformed, which matches no
 * lock, so a hand-run of this file without a claim adopts nothing and exits as SKIP_INPROGRESS.
 */
// webpieces-disable no-function-outside-class -- argv parse for this detached main(), matching the file's existing shape
export function claimStartedFromArgv(argv: string[]): number {
    const raw = argv[3];
    return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
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
export async function refreshMainSync(repoRoot: string, claimStarted: number, argvDetail: string = ''): Promise<void> {
    const startedMs = Date.now();

    // First action: prove the detached child actually started. If the async-refresh stream has no START line
    // for a spawn, the child never launched (or died before this point).
    logSyncEvent(repoRoot, new SyncLogEvent('START', process.pid, '-', `argv=${argvDetail}`));

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // ADOPT the spawner's lock, never create one: the spawner already won it atomically.
        const lock = locks.adoptMainSyncLock(repoRoot, claimStarted);
        if (!lock) {
            logSyncEvent(repoRoot, new SyncLogEvent('SKIP_INPROGRESS', process.pid, '-', `the spawner's lock ${String(claimStarted)} is no longer on disk; another refresh owns this run`));
            return;
        }
        let file: MainSyncStatusFile | null = null;
        let outcome = RefreshOutcome.ERROR;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // EVERY worktree's branch, not just ours. The cache is shared by the whole repo but used
            // to describe only the branch of whichever tree won this lock, so every other worktree's
            // guards read a cross-branch cache and abstained. One fetch + one `gh` call now arms all
            // of them; the map is rebuilt from the live worktree set, so dead branches drop out.
            file = await status.computeAllMainSyncStatuses(repoRoot);

            // Second slow signal, same lock, same detached run: which local branches are dead. One bulk
            // `gh pr list --state merged` call. The branch-creation-guard reads the result to enforce its
            // cap without ever touching the network itself. Deliberately allowed to go stale.
            const mergedBranches = new MergedBranchesService();
            // `false`: the background refresher NEVER ignores a standing agent lock. That flag is
            // wp-cleanup's, and it means "a human asked for this run" — nothing an unattended
            // refresher can claim on somebody's behalf.
            const cache = await mergedBranches.computeMergedBranches(repoRoot, false);
            mergedBranches.writeMergedBranches(repoRoot, cache);

            // Third step, same detached run: actually DELETE the dead branches. Reporting them was
            // never enough — the reap was only ever a `git branch -D` string in a fix hint, which an
            // agent reads as destructive and stalls on, so nothing was ever cleaned. Here nobody has
            // to be asked. Reuses the verdicts we JUST computed (no second `gh` call).
            const reaped = await autoReap(repoRoot, cache);

            // FINISH after a successful run — START-without-FINISH means we were killed mid-run.
            outcome = RefreshOutcome.OK;
            const names = Object.keys(file.branches);
            logSyncEvent(repoRoot, new SyncLogEvent(
                'FINISH', process.pid, names.join(','),
                `branches=${String(names.length)} ${names.map(summarize(file)).join(' ')} deletableBranches=${String(cache.deletable.length)} reaped=${String(reaped)} ms=${String(Date.now() - startedMs)}`,
            ));
        } finally {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
            try {
                // Stamp FIRST: a failed run (offline, gh auth) still counts as a run, so it is retried
                // after MIN_REFRESH_INTERVAL_MINUTES rather than hammered on every tool call.
                recordRun(repoRoot, file, lock.startedMs, outcome);
            } finally {
                // Lock LAST, and only if still ours: a run that hung past its window was reclaimed,
                // and deleting the newer holder's lock would let a third refresher start beside it.
                locks.releaseMainSyncLock(repoRoot, lock);
            }
        }
    } catch (err: unknown) {
        const error = toError(err);
        // Detached: swallow so a transient git/fs error never leaves poison state (the next hook call
        // spawns a fresh refresher) — but record WHY it died so the failure isn't invisible.
        logSyncEvent(repoRoot, new SyncLogEvent('ERROR', process.pid, '-', `${error.message} | ${error.stack ?? ''}`));
    }
}

/**
 * Write this run's results and its stamp to main-sync-status.json (atomically). With fresh branch data
 * the whole document is replaced; without it (the compute threw) only the stamp and outcome are
 * updated, keeping the previous branch data the guards are still reading.
 */
// webpieces-disable no-function-outside-class -- module-level helper of this detached main(), matching the file's existing shape
function recordRun(repoRoot: string, file: MainSyncStatusFile | null, startedMs: number, outcome: RefreshOutcome): void {
    if (file === null) {
        status.recordRefreshOutcome(repoRoot, startedMs, outcome);
        return;
    }
    file.lastRefreshStartedMs = startedMs;
    file.lastRefreshOutcome = outcome;
    status.writeMainSyncStatusFile(repoRoot, file);
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
async function autoReap(repoRoot: string, cache: MergedBranchesCache): Promise<number> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const config = loadAndValidate(repoRoot).rulesConfig['branch-creation-guard'] as BranchCreationGuardConfig | undefined;
        // Strictly opt-IN: only an explicit `true` reaps. `autoReapMergedBranches` is schema-required,
        // so every validated config states an answer — which means "absent" here is not a consumer
        // who wants the default, it is a config that never passed validation. Deleting branches on
        // that basis would be deleting on a preference nobody expressed.
        if (config?.mode === 'OFF' || config?.autoReapMergedBranches !== true) return 0;

        const result: ReapResult = await new BranchReaper().reap(repoRoot, 'auto-reap', cache);
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

if (require.main === module) runMain(main);
