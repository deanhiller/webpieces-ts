import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MainSyncLock, MainSyncStatusService } from '@webpieces/rules-config';

import { refreshMainSync } from './sync-main';

// Log FILENAMES now carry the stream prefix (see LogStream). Specs resolve the name the same way
// production does, so the layout is regression-tested on the REAL path rather than a fallback.
import { LogStream } from './log-stream';
function streamName(base: string): string { return new LogStream().fileName(base); }


/**
 * SINGLE-FLIGHT IS UNCHANGED by the move to a branch-keyed map.
 *
 * The map changed only WHAT the winner writes — one `.git`, one `origin/main`, one fetch, one
 * refresher, the same lock. That is worth a test of its own, because "record every worktree" is
 * exactly the kind of change that invites letting a second refresher run per worktree.
 */

let root: string;
const service = new MainSyncStatusService();

function asyncLog(): string {
    const logPath = path.join(root, '.webpieces', 'logs', streamName('guard-async-work.log'));
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'syncmain-')));
});

afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('sync-main single-flight', () => {
    it('a loser logs SKIP_INPROGRESS and writes no status at all', () => {
        // A live refresher (this very process's pid, so the liveness probe says "running") holds the
        // lock. The second refresher must not fetch, must not compute, must not write.
        service.writeMainSyncLock(root, new MainSyncLock('inprocess', Date.now(), process.pid));

        refreshMainSync(root, 5);

        expect(asyncLog()).toContain('SKIP_INPROGRESS');
        expect(asyncLog()).not.toContain('FINISH');
        expect(fs.existsSync(service.mainSyncStatusPath(root))).toBe(false);
        // The holder's lock is untouched — a loser must never flip it to `finished`.
        expect(service.readMainSyncLock(root)?.state).toBe('inprocess');
        expect(service.readMainSyncLock(root)?.pid).toBe(process.pid);
    });

    it('does not treat a DEAD holder as in flight — the lock is still reclaimable', () => {
        service.writeMainSyncLock(root, new MainSyncLock('inprocess', Date.now(), 2147483646));

        refreshMainSync(root, 5);

        // It got past the acquire. The run itself is a no-op in a non-git directory, but it must not
        // have been skipped, and the lock must end up released rather than wedged.
        expect(asyncLog()).toContain('START');
        expect(asyncLog()).not.toContain('SKIP_INPROGRESS');
        expect(service.readMainSyncLock(root)?.state).toBe('finished');
    });
});
