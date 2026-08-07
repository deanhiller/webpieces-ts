import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_HANG_TIMEOUT_MINUTES } from '@webpieces/rules-config';

import { toError } from './to-error';
import { logSyncEvent, SyncLogEvent, refresherChildStdioPath } from './main-sync-log';
import { logStream, StreamIdentity } from './log-stream';

// Per-process latch for the spawn below. A hook process handles exactly one tool call, so this makes
// the refresher at-most-once per tool call. Exported reset is test-only.
let alreadyTriggered = false;

// webpieces-disable no-function-outside-class -- test-only latch reset, matching this module's function shape
export function resetMainSyncRefreshLatchForTest(): void {
    alreadyTriggered = false;
}

/**
 * The detached child's argv, spawner side. Positions here are offset by two from the child's
 * `process.argv` (node + script path), so this array's 3/4/5 are the child's 4/5/6 — which is what
 * `sync-main.ts:spawnerIdentity` reads. The two are pinned against each other by ONE test, because a
 * silent disagreement about these positions IS the bug being fixed: the child previously received no
 * identity at all and wrote every line to the shared `unknown-coordinator-hook-` stream.
 */
// webpieces-disable no-function-outside-class -- argv builder for this module's spawn, matching its function shape
export function refresherArgv(refresher: string, workspaceRoot: string, hangTimeoutMinutes: number, identity: StreamIdentity): string[] {
    return [refresher, workspaceRoot, String(hangTimeoutMinutes), identity.sessionId, identity.agentId, identity.hook];
}

/**
 * Fire-and-forget spawn of the detached refresher (sync-main.js in this same dir — spawned by path,
 * not a bin). The child outlives this hook process (`detached` + `unref`), does the slow
 * merged-PR/fetch/merge-base/overlap work, and writes the cache the feature-branch-guard reads on
 * the NEXT call. This is the first detached spawn in the codebase — every existing hook is synchronous.
 *
 * Observability: we log SPAWN_ATTEMPT here and the child logs START/FINISH/ERROR, all to
 * `.webpieces/logs/<stream>guard-async-work.log` (LogStream prefixes every name). The child's
 * stdout/stderr are redirected to a sibling file (not
 * /dev/null) so a crash before the child's own logging is still captured. If guard-async-work.log shows
 * SPAWN_ATTEMPT but never START, the detached child was killed before it ran.
 *
 * THE IDENTITY GOES ON ARGV, and that is what makes the sentence above true. The child is a separate
 * node process whose `logStream` starts unidentified, so it used to write every line to the shared
 * `unknown-coordinator-hook-guard-async-work.log` while this parent wrote SPAWN_ATTEMPT to its own
 * prefixed stream. One cycle, two files — the SPAWN_ATTEMPT-without-START check then read as a
 * failure on every cycle even when the child ran perfectly — and every agent's child appending to
 * that one shared path is exactly the multi-writer tearing LogStream exists to remove. Passing
 * session/agent/hook through (positional argv, alongside the root and timeout the child already
 * takes) puts the whole cycle back in ONE file.
 */
export function triggerMainSyncRefresh(workspaceRoot: string, hangTimeoutMinutes: number = DEFAULT_HANG_TIMEOUT_MINUTES): void {
    // ONE refresher per hook process. Several call sites fire this on a single tool call — the Read
    // fast path in hook-core AND read-stale-guard's own check(), for one — which is why the log showed
    // two SPAWN_ATTEMPTs ~20ms apart from the same pid on every cycle. The loser only ever reached the
    // lock and exited, so the second child was pure waste (and one more `git fetch` racing the
    // agent's). The child's lock still guards against refreshers from OTHER hook processes.
    if (alreadyTriggered) return;
    alreadyTriggered = true;

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const refresher = path.join(__dirname, 'sync-main.js');
        // SPAWN_ATTEMPT first — this also creates .webpieces/logs so the stderr fd below can open.
        logSyncEvent(workspaceRoot, new SyncLogEvent('SPAWN_ATTEMPT', process.pid, '-', `refresher=${refresher}`));

        // Redirect the detached child's stdout+stderr to a file (not /dev/null) so an uncaught crash
        // before the child's own logging — e.g. a module-load failure — is still captured.
        const errFd = fs.openSync(refresherChildStdioPath(workspaceRoot), 'a');
        const child = spawn(process.execPath, refresherArgv(refresher, workspaceRoot, hangTimeoutMinutes, logStream.identity()), {
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
        void error;
        // Spawning the background refresh must never block or fail the tool call.
    }
}
