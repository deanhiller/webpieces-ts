import * as fs from 'fs';
import * as path from 'path';

import { toError } from './to-error';

// The ASYNC log — observability for the detached background refresher (sync-main.ts) that writes
// main-sync-status.json. Its companion is the SYNC log (sync-decisions.log, decision-log.ts) which
// records what the hook DECIDED using that cache. The refresher runs AFTER the spawning hook has
// exited, with stdio discarded, so when it fails to update the cache there is normally no trace.
// This log captures its lifecycle — SPAWN_ATTEMPT (parent side), then START / SKIP_INPROGRESS /
// FINISH / ERROR (child side) — so we can tell whether the detached child never launched, was killed
// mid-run (START with no FINISH), or threw. Writes to `.webpieces/hooks/async-refresh.log`.
const HOOKS_DIR = '.webpieces/hooks';
const LOG_FILE = 'async-refresh.log';
const LOG_FILE_PREV = 'async-refresh.1.log';
const STDERR_FILE = 'async-refresh.stderr.log';
const MAX_LOG_BYTES = 512 * 1024; // 512 KB — rotate when exceeded (mirrors decision-log)
const MAX_DETAIL_LEN = 300;

export type SyncPhase = 'SPAWN_ATTEMPT' | 'START' | 'SKIP_INPROGRESS' | 'FINISH' | 'ERROR';

// Data-only record of one refresher lifecycle event (per CLAUDE.md: classes for data).
export class SyncLogEvent {
    phase: SyncPhase;
    pid: number;
    branchArg: string;
    detail: string;

    constructor(phase: SyncPhase, pid: number, branchArg: string, detail: string) {
        this.phase = phase;
        this.pid = pid;
        this.branchArg = branchArg;
        this.detail = detail;
    }
}

/**
 * Append one tab-separated line per refresher event to `.webpieces/hooks/async-refresh.log`. `root` is
 * the workspace root holding `.webpieces`. Swallows all errors — logging must never block or fail
 * the refresher (or the hook that spawns it).
 */
export function logSyncEvent(root: string, event: SyncLogEvent): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const timestamp = new Date().toISOString();
        const hooksDir = path.join(root, HOOKS_DIR);
        fs.mkdirSync(hooksDir, { recursive: true });

        const logPath = path.join(hooksDir, LOG_FILE);
        rotateLogFile(logPath, path.join(hooksDir, LOG_FILE_PREV));

        const line = [
            `[${timestamp}]`,
            event.phase,
            `pid=${String(event.pid)}`,
            event.branchArg,
            oneLine(event.detail),
        ].join('\t') + '\n';
        fs.appendFileSync(logPath, line);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
}

// Absolute path the detached child's stdout/stderr are redirected to (opened with fs.openSync(p,'a')
// by the spawner), so even a crash BEFORE our own logging runs — e.g. a module-load failure — is
// captured instead of vanishing into /dev/null. Callers must ensure the hooks dir exists first
// (logSyncEvent's mkdir, called for SPAWN_ATTEMPT, does that).
export function syncStderrLogPath(root: string): string {
    return path.join(root, HOOKS_DIR, STDERR_FILE);
}

// Collapse newlines/tabs and cap length so one event is always one log line.
function oneLine(value: string): string {
    const flat = value.replace(/[\t\r\n]+/g, ' ').trim();
    return flat.length <= MAX_DETAIL_LEN ? flat : flat.slice(0, MAX_DETAIL_LEN) + '…';
}

function rotateLogFile(logPath: string, prevPath: string): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const stat = fs.statSync(logPath);
        if (stat.size > MAX_LOG_BYTES) {
            if (fs.existsSync(prevPath)) fs.unlinkSync(prevPath);
            fs.renameSync(logPath, prevPath);
        }
    } catch (err: unknown) {
        const error = toError(err);
        void error;
    }
}
