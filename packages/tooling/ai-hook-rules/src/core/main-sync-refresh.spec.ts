import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { triggerMainSyncRefresh, resetMainSyncRefreshLatchForTest } from './main-sync-refresh';

const LOG_REL = '.webpieces/hooks/guard-async-work.log';

function spawnAttempts(root: string): number {
    const logPath = path.join(root, LOG_REL);
    if (!fs.existsSync(logPath)) return 0;
    return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line: string): boolean => line.includes('\tSPAWN_ATTEMPT\t'))
        .length;
}

// A hook process handles ONE tool call, but several call sites fire the refresher on that one call
// (hook-core's Read fast path AND read-stale-guard's own check(), for one). That is what put two
// SPAWN_ATTEMPTs ~20ms apart in every log cycle, and the second child was one more `git fetch`
// racing the agent's foreground git for the unlocked `.git/FETCH_HEAD`.
describe('triggerMainSyncRefresh — at most one refresher per hook process', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-refresh-'));
        resetMainSyncRefreshLatchForTest();
    });

    it('spawns once no matter how many call sites fire on the same tool call', () => {
        triggerMainSyncRefresh(root);
        triggerMainSyncRefresh(root);
        triggerMainSyncRefresh(root);
        expect(spawnAttempts(root)).toBe(1);
    });

    it('spawns again in the NEXT hook process (the latch is per-process, not per-repo)', () => {
        triggerMainSyncRefresh(root);
        resetMainSyncRefreshLatchForTest();  // stands in for a fresh hook process
        triggerMainSyncRefresh(root);
        expect(spawnAttempts(root)).toBe(2);
    });
});
