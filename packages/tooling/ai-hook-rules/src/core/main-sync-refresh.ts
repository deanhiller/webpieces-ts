import { spawn } from 'child_process';
import * as path from 'path';

import { DEFAULT_HANG_TIMEOUT_MINUTES } from '@webpieces/rules-config';

import { toError } from './to-error';

/**
 * Fire-and-forget spawn of the detached refresher (sync-main.js in this same dir — spawned by path,
 * not a bin). The child outlives this hook process (`detached` + `unref`), does the slow
 * merged-PR/fetch/merge-base/overlap work, and writes the cache the feature-branch-guard reads on
 * the NEXT call. This is the first detached spawn in the codebase — every existing hook is synchronous.
 */
export function triggerMainSyncRefresh(workspaceRoot: string, hangTimeoutMinutes: number = DEFAULT_HANG_TIMEOUT_MINUTES): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const refresher = path.join(__dirname, 'sync-main.js');
        const child = spawn(process.execPath, [refresher, workspaceRoot, String(hangTimeoutMinutes)], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        // Spawning the background refresh must never block or fail the tool call.
    }
}
