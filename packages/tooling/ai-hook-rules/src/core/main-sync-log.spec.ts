import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logSyncEvent, SyncLogEvent, syncStderrLogPath } from './main-sync-log';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-synclog-'));
}

const LOG_REL = '.webpieces/hooks/async-refresh.log';

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

    it('rotates to async-refresh.1.log once the log exceeds the size cap', () => {
        const root = tmpRoot();
        const hooksDir = path.join(root, '.webpieces/hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(path.join(hooksDir, 'async-refresh.log'), 'x'.repeat(512 * 1024 + 10));
        logSyncEvent(root, new SyncLogEvent('FINISH', 1, 'main', 'ok'));
        expect(fs.existsSync(path.join(hooksDir, 'async-refresh.1.log'))).toBe(true);
        expect(fs.readFileSync(path.join(hooksDir, 'async-refresh.log'), 'utf8')).toContain('\tFINISH\t');
    });

    it('collapses newlines/tabs in detail so one event is always one line', () => {
        const root = tmpRoot();
        logSyncEvent(root, new SyncLogEvent('ERROR', 2, '-', 'line1\nline2\tline3'));
        const content = fs.readFileSync(path.join(root, LOG_REL), 'utf8');
        expect(content.trim().split('\n').length).toBe(1);
        expect(content).toContain('line1 line2 line3');
    });

    it('syncStderrLogPath points inside .webpieces/hooks', () => {
        expect(syncStderrLogPath('/repo')).toBe(path.join('/repo', '.webpieces/hooks', 'async-refresh.stderr.log'));
    });
});
