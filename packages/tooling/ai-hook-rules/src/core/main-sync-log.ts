import * as fs from 'fs';
import * as path from 'path';

import { dotWebpieces } from '@webpieces/rules-config';
import { ASYNC_REFRESH_STREAM } from './log-streams';

import { toError } from './to-error';
import { logStream } from './log-stream';

// The ASYNC log — observability for the detached background refresher (sync-main.ts) that writes
// main-sync-status.json. Its companion is the SYNC log (sync-decisions.log, decision-log.ts) which
// records what the hook DECIDED using that cache. The refresher runs AFTER the spawning hook has
// exited, with stdio discarded, so when it fails to update the cache there is normally no trace.
// This log captures its lifecycle — SPAWN_ATTEMPT (parent side), then START / SKIP_INPROGRESS /
// FINISH / ERROR (child side) — so we can tell whether the detached child never launched, was killed
// mid-run (START with no FINISH), or threw. Writes to
// `.webpieces/logs/async-refresh/<writer>.log`, where <writer> is LogStream's
// `<sessionId>-<agentId|coordinator>-<hook>` key (see LOGS_STATE_DIR and ASYNC_REFRESH_STREAM).
//
// THE CHILD'S RAW STDIO GOES TO THIS SAME FILE. It used to have a `.stderr.log` sibling, which was
// 0 bytes on every measured run — it is written to ONLY when the child dies before its own logging
// (a module-load failure, say), and that is precisely the moment you want the crash output sitting
// directly beneath the SPAWN_ATTEMPT that preceded it, in time order, rather than in a second file
// you have to think to open. Same cycle, same writer, one file.
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
 * Append one tab-separated line per refresher event to
 * `.webpieces/logs/<stream>guard-async-work.log` (see LogStream for the prefix). `root` is
 * the workspace root holding `.webpieces`. Swallows all errors — logging must never block or fail
 * the refresher (or the hook that spawns it).
 */
export function logSyncEvent(root: string, event: SyncLogEvent): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const timestamp = new Date().toISOString();
        // LOCAL scope: this is the refresher's own lifecycle trace for THIS worktree. One writer per
        // log, so its appends cannot interleave with another agent's.
        const logsDir = dotWebpieces.logsFile(root, ASYNC_REFRESH_STREAM);
        fs.mkdirSync(logsDir, { recursive: true });

        const logPath = path.join(logsDir, logStream.writerFile('.log'));
        rotateLogFile(logPath, path.join(logsDir, logStream.writerFile('.1.log')));

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

// The path the detached child's stdout/stderr are redirected to (opened with fs.openSync(p,'a') by
// the spawner), so even a crash BEFORE our own logging runs — e.g. a module-load failure — is
// captured instead of vanishing into /dev/null. Callers must ensure the log dir exists first
// (logSyncEvent's mkdir, called for SPAWN_ATTEMPT, does that).
//
// This is THE SAME FILE logSyncEvent appends to — see the header. It is not a second stream and it
// no longer has a name of its own.
export function syncStderrLogPath(root: string): string {
    return dotWebpieces.logsFile(root, ASYNC_REFRESH_STREAM, logStream.writerFile('.log'));
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
