import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_HANG_TIMEOUT_MINUTES } from '@webpieces/rules-config';

import { toError } from './to-error';
import { logSyncEvent, SyncLogEvent, syncStderrLogPath } from './main-sync-log';

/**
 * Fire-and-forget spawn of the detached refresher (sync-main.js in this same dir — spawned by path,
 * not a bin). The child outlives this hook process (`detached` + `unref`), does the slow
 * merged-PR/fetch/merge-base/overlap work, and writes the cache the feature-branch-guard reads on
 * the NEXT call. This is the first detached spawn in the codebase — every existing hook is synchronous.
 *
 * Observability: we log SPAWN_ATTEMPT here and the child logs START/FINISH/ERROR, all to
 * `.webpieces/hooks/guard-async-work.log`. The child's stdout/stderr are redirected to a sibling file (not
 * /dev/null) so a crash before the child's own logging is still captured. If guard-async-work.log shows
 * SPAWN_ATTEMPT but never START, the detached child was killed before it ran.
 */
export function triggerMainSyncRefresh(workspaceRoot: string, hangTimeoutMinutes: number = DEFAULT_HANG_TIMEOUT_MINUTES): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const refresher = path.join(__dirname, 'sync-main.js');
        // SPAWN_ATTEMPT first — this also creates .webpieces/hooks so the stderr fd below can open.
        logSyncEvent(workspaceRoot, new SyncLogEvent('SPAWN_ATTEMPT', process.pid, '-', `refresher=${refresher}`));

        // Redirect the detached child's stdout+stderr to a file (not /dev/null) so an uncaught crash
        // before the child's own logging — e.g. a module-load failure — is still captured.
        const errFd = fs.openSync(syncStderrLogPath(workspaceRoot), 'a');
        const child = spawn(process.execPath, [refresher, workspaceRoot, String(hangTimeoutMinutes)], {
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
