import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { toError } from '@webpieces/tooling-common/to-error';
import { MainSyncLock, MainSyncLockService, MainSyncStatusService, RefreshClaimOutcome, RefreshOutcome } from '@webpieces/repo-workflow-core';
import { logSyncEvent, SyncLogEvent, refresherChildStdioPath } from './main-sync-log';
import { logStream, StreamIdentity } from './log-stream';

// Per-process latch for the spawn below. A hook process handles exactly one tool call, so this makes
// the refresher at-most-once per tool call. Exported reset is test-only.
let alreadyTriggered = false;

// The services the spawner throttles and claims through. Module scope, like the latch: this path must
// stay callable from a tree too broken to build a DI container.
const mainSyncStatus = new MainSyncStatusService();
const mainSyncLocks = new MainSyncLockService(undefined, undefined, mainSyncStatus);

// webpieces-disable no-function-outside-class -- test-only latch reset, matching this module's function shape
export function resetMainSyncRefreshLatchForTest(): void {
    alreadyTriggered = false;
}

/**
 * The detached child's argv, spawner side. Positions here are offset by two from the child's
 * `process.argv` (node + script path), so this array's 3/4/5 are the child's 4/5/6 — which is what
 * `sync-main.ts:spawnerIdentity` reads — and its 2 (the lock's `startedMs`) is the child's 3, which
 * `sync-main.ts:claimStartedFromArgv` reads. The hang timeout no longer travels: the child adopts a
 * lock the spawner already took, so it has nothing to time out. The two are pinned against each other
 * by ONE test, because a
 * silent disagreement about these positions IS the bug being fixed: the child previously received no
 * identity at all and wrote every line to the shared `unknown-coordinator-hook-` stream.
 */
// webpieces-disable no-function-outside-class -- argv builder for this module's spawn, matching its function shape
export function refresherArgv(refresher: string, workspaceRoot: string, claimStarted: number, identity: StreamIdentity): string[] {
    return [refresher, workspaceRoot, String(claimStarted), identity.sessionId, identity.agentId, identity.hook];
}

/**
 * Fire-and-forget spawn of the detached refresher (sync-main.js in this same dir — spawned by path,
 * not a bin). The child outlives this hook process (`detached` + `unref`), does the slow
 * merged-PR/fetch/merge-base/overlap work, and writes the cache the feature-branch-guard reads on
 * the NEXT call. This is the first detached spawn in the codebase — every existing hook is synchronous.
 *
 * THROTTLED AND SINGLE-FLIGHT IN THE SPAWNER (#1342): at most one refresher START per
 * MIN_REFRESH_INTERVAL_MINUTES per repo, decided here by one read of `lastRefreshStartedMs` in
 * `main-sync-status.json` before any process is launched. Past the interval the spawner creates
 * `main-sync.lock.json` exclusively, so of several hook processes firing at once exactly one launches.
 * The child ADOPTS that lock (it never creates one itself), stamps the status file, and deletes the
 * lock last.
 *
 * Observability: we log SPAWN_ATTEMPT here and the child logs START/FINISH/ERROR, all to
 * `.webpieces/logs/async-refresh/<writer>.log` (LogStream names every writer). The child's
 * stdout/stderr are redirected to a sibling file (not
 * /dev/null) so a crash before the child's own logging is still captured. If the async-refresh stream shows
 * SPAWN_ATTEMPT but never START, the detached child was killed before it ran.
 *
 * `hangTimeoutMinutes` IS REQUIRED, deliberately. It used to default to DEFAULT_HANG_TIMEOUT_MINUTES,
 * and that default is the mechanism by which three of the four configured values could never reach a
 * spawn: two callers ran before any guard and simply omitted the argument, and the at-most-once latch
 * below then meant the guard's own call — the one carrying the configured value — was a no-op. An
 * omitted argument that silently means "the default" is unreadable at the call site and impossible to
 * grep. Required makes every caller say which value it is passing, and makes forgetting a compile error.
 *
 * THE IDENTITY GOES ON ARGV, and that is what makes the sentence above true. The child is a separate
 * node process whose `logStream` starts unidentified, so it used to write every line to the shared
 * `unknown-coordinator-hook.log` while this parent wrote SPAWN_ATTEMPT to its own
 * prefixed stream. One cycle, two files — the SPAWN_ATTEMPT-without-START check then read as a
 * failure on every cycle even when the child ran perfectly — and every agent's child appending to
 * that one shared path is exactly the multi-writer tearing LogStream exists to remove. Passing
 * session/agent/hook through (positional argv, alongside the root and timeout the child already
 * takes) puts the whole cycle back in ONE file.
 */
// webpieces-disable no-function-outside-class -- the module's one entry point, beside refresherArgv; a detached fire-and-forget spawn has no state to inject and must stay callable from a tree too broken to build a DI container
export function triggerMainSyncRefresh(workspaceRoot: string, hangTimeoutMinutes: number): void {
    // ONE refresher per hook process. Several call sites fire this on a single tool call — the Read
    // fast path in hook-core AND read-stale-guard's own check(), for one — which is why the log showed
    // two SPAWN_ATTEMPTs ~20ms apart from the same pid on every cycle. The loser only ever reached the
    // lock and exited, so the second child was pure waste (and one more `git fetch` racing the
    // agent's). The claim below guards against refreshers from OTHER hook processes.
    if (alreadyTriggered) return;
    alreadyTriggered = true;

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // THE THROTTLE LIVES HERE, IN THE SPAWNER (#1342) — not in the child, which only learned it had
        // nothing to do after node had already booted (measured: 6500 SPAWN_ATTEMPTs, 2677 of them
        // ending in SKIP_INPROGRESS). One read of the status file's stamp decides; a throttled call
        // launches nothing. The lock is created exclusively, so of N hook processes firing at once
        // exactly one spawns. See MainSyncLockService.claimRefresh for the stamp semantics.
        //
        // A skip writes NO log line. It is the outcome of nearly every tool call, so logging it would
        // trade the SPAWN_ATTEMPT flood for a SKIP flood. The throttle is visible instead as
        // SPAWN_ATTEMPTs at least MIN_REFRESH_INTERVAL_MINUTES apart, each naming the run it follows.
        const claim = mainSyncLocks.claimRefresh(workspaceRoot, hangTimeoutMinutes);
        if (claim.outcome !== RefreshClaimOutcome.CLAIMED || claim.lock === null) return;
        spawnRefresher(workspaceRoot, claim.lock, claim.lastRefreshStartedMs);
    } catch (err: unknown) { // webpieces-disable catch-must-propagate -- warming a background cache must never block or fail the agent's tool call; there is no caller to propagate to
        const error = toError(err);
        void error;
    }
}

/**
 * Launch the detached refresher for a lock this process WON. If the launch fails synchronously the run
 * is recorded as an ERROR (stamp first) and the lock deleted (last), so the next attempt waits out the
 * interval like any failed run, rather than an unadopted lock sitting until the hang window expires.
 */
// webpieces-disable no-function-outside-class -- the spawn half of triggerMainSyncRefresh, beside it in this module-scope spawner
function spawnRefresher(workspaceRoot: string, claim: MainSyncLock, lastRefreshStartedMs: number | null): void {
    const refresher = path.join(__dirname, 'sync-main.js');
    const after = lastRefreshStartedMs === null ? 'none' : new Date(lastRefreshStartedMs).toISOString();
    // SPAWN_ATTEMPT first — this also creates .webpieces/logs so the stderr fd below can open.
    logSyncEvent(workspaceRoot, new SyncLogEvent('SPAWN_ATTEMPT', process.pid, '-', `refresher=${refresher} lockStartedMs=${String(claim.startedMs)} previousStart=${after}`));

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        // Redirect the detached child's stdout+stderr to a file (not /dev/null) so an uncaught crash
        // before the child's own logging — e.g. a module-load failure — is still captured.
        const errFd = fs.openSync(refresherChildStdioPath(workspaceRoot), 'a');
        const child = spawn(process.execPath, refresherArgv(refresher, workspaceRoot, claim.startedMs, logStream.identity()), {
            detached: true,
            stdio: ['ignore', errFd, errFd],
        });
        // spawn errors (e.g. ENOENT) arrive asynchronously; record one if it fires. The hook may exit
        // before this handler runs, but on POSIX a successful exec has already happened by now.
        child.once('error', (err: Error): void => {
            logSyncEvent(workspaceRoot, new SyncLogEvent('ERROR', child.pid ?? -1, '-', `spawn failed: ${err.message}`));
        });
        child.unref();
        // The child has its own dup'd copy of the fd after spawn; close the parent's copy.
        fs.closeSync(errFd);
    } catch (err: unknown) {
        const error = toError(err);
        mainSyncStatus.recordRefreshOutcome(workspaceRoot, claim.startedMs, RefreshOutcome.ERROR);
        mainSyncLocks.releaseMainSyncLock(workspaceRoot, claim);
        throw error;
    }
}
