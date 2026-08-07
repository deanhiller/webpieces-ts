import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logSyncEvent, SyncLogEvent, syncStderrLogPath } from './main-sync-log';

// Log FILENAMES now carry the stream prefix (see LogStream). Specs resolve the name the same way
// production does, so the layout is regression-tested on the REAL path rather than a fallback.
import { LogStream } from './log-stream';
import { L2_DECISIONS_STREAM, CALLS_STREAM, ASYNC_REFRESH_STREAM, REJECTIONS_STREAM } from './log-streams';
// The layer-first layout: a base name maps to its STREAM DIRECTORY plus this writer's file, so a
// spec still names one logical stream and the path it checks is the real one production builds.
const STREAM_OF: Record<string, string> = {
    'guard-invocations': CALLS_STREAM,
    'guard-sync-decisions': L2_DECISIONS_STREAM,
    'guard-async-work': ASYNC_REFRESH_STREAM,
    'hook-rejection': REJECTIONS_STREAM,
};
function streamName(base: string): string {
    const rot = base.endsWith('.1.log') ? '.1.log' : (base.endsWith('.log') ? '.log' : '');
    // `.stderr` no longer names a stream of its own — the child's raw stdio goes to the SAME file.
    const stem = base.replace(/(\.1)?\.log$/, '').replace(/\.stderr$/, '');
    return path.join(STREAM_OF[stem], new LogStream().writerFile(rot));
}


function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-synclog-'));
}

const LOG_REL = `.webpieces/logs/${streamName('guard-async-work.log')}`;

describe('main-sync-log', () => {
    it('appends one tab-separated line with phase, pid, branch and detail', () => {
        const root = tmpRoot();
        logSyncEvent(root, new SyncLogEvent('START', 1234, 'dean/x', 'argv=/repo 5'));
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content).toContain('\tSTART\t');
        expect(content).toContain('pid=1234');
        expect(content).toContain('dean/x');
        expect(content.trim().split('\n').length).toBe(1);
    });

    it('rotates to guard-async-work.1.log once the log exceeds the size cap', () => {
        const root = tmpRoot();
        const logsDir = path.join(root, '.webpieces/logs');
        fs.mkdirSync(path.join(logsDir, ASYNC_REFRESH_STREAM), { recursive: true });
        fs.writeFileSync(path.join(logsDir, streamName('guard-async-work.log')), 'x'.repeat(512 * 1024 + 10));
        logSyncEvent(root, new SyncLogEvent('FINISH', 1, 'main', 'ok'));
        expect(fs.existsSync(path.join(logsDir, streamName('guard-async-work.1.log')))).toBe(true);
        expect(fs.readFileSync(path.join(logsDir, streamName('guard-async-work.log')), 'utf8')).toContain('\tFINISH\t');
    });

    it('collapses newlines/tabs in detail so one event is always one line', () => {
        const root = tmpRoot();
        logSyncEvent(root, new SyncLogEvent('ERROR', 2, '-', 'line1\nline2\tline3'));
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content.trim().split('\n').length).toBe(1);
        expect(content).toContain('line1 line2 line3');
    });

    it('syncStderrLogPath points inside .webpieces/logs', () => {
        expect(syncStderrLogPath('/repo')).toBe(path.join('/repo', '.webpieces/logs', streamName('guard-async-work.stderr.log')));
    });
});
