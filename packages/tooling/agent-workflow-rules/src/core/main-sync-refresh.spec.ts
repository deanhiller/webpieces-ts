import { policyFixture } from '@webpieces/tooling-testkit';
import { specTempDirs } from '@webpieces/tooling-testkit';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { triggerMainSyncRefresh, resetMainSyncRefreshLatchForTest, refresherArgv } from './main-sync-refresh';
import { claimStartedFromArgv, spawnerIdentity } from './sync-main';
import { DEFAULT_HANG_TIMEOUT_MINUTES, MIN_REFRESH_INTERVAL_MINUTES, MainSyncLock, MainSyncLockService, MainSyncStatusService, RefreshOutcome } from '@webpieces/repo-workflow-core';


// Log FILENAMES carry the stream prefix (see LogStream). Specs resolve the name exactly as
// production does, so the layout is regression-tested on the REAL path, not a fallback.
import { LogStream, StreamIdentity } from './log-stream';
import { L2_DECISIONS_STREAM, CALLS_STREAM, ASYNC_REFRESH_STREAM, REJECTIONS_STREAM } from './log-streams';
// One writer's path inside a STREAM DIRECTORY — `<stream>/<sessionId>-<agent>-<hook><suffix>`, the
// real layout production builds. Takes the stream CONSTANT, so no dead filename survives in a fixture.
function streamName(stream: string, suffix: string = '.log'): string {
    return path.join(stream, new LogStream().writerFile(suffix));
}


const LOG_REL = `.webpieces/logs/${streamName(ASYNC_REFRESH_STREAM)}`;

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
        root = policyFixture.makeRepo('wp-refresh-');
        resetMainSyncRefreshLatchForTest();
    });

    it('spawns once no matter how many call sites fire on the same tool call', () => {
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        expect(spawnAttempts(root)).toBe(1);
    });

    it('the latch is per-process: the NEXT hook process decides afresh, and is throttled here', () => {
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        resetMainSyncRefreshLatchForTest();  // stands in for a fresh hook process
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        // The second process got past the latch and was stopped by the repo-wide interval instead.
        expect(spawnAttempts(root)).toBe(1);
    });
});

const MINUTE = 60 * 1000;
const status = new MainSyncStatusService();
const locks = new MainSyncLockService(undefined, undefined, status);

// #1342: the throttle is the SPAWNER's. A throttled tool call launches no node child and runs no git;
// the async-refresh stream used to show a SPAWN_ATTEMPT (and a node boot) on every guard fire.
describe('triggerMainSyncRefresh — at most one refresher START per interval per repo', () => {
    let root: string;

    beforeEach(() => {
        root = policyFixture.makeRepo('wp-throttle-');
        resetMainSyncRefreshLatchForTest();
    });

    it('launches nothing, and logs nothing, when the last refresh started inside the interval', () => {
        status.recordRefreshOutcome(root, Date.now() - (MIN_REFRESH_INTERVAL_MINUTES - 1) * MINUTE, RefreshOutcome.OK);
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        expect(spawnAttempts(root)).toBe(0);
        expect(fs.existsSync(path.join(root, LOG_REL))).toBe(false);
        expect(fs.existsSync(locks.mainSyncLockPath(root))).toBe(false);
    });

    it('launches once the interval has elapsed, and creates the lock for the child to adopt', () => {
        status.recordRefreshOutcome(root, Date.now() - (MIN_REFRESH_INTERVAL_MINUTES + 1) * MINUTE, RefreshOutcome.ERROR);
        const before = Date.now();
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        expect(spawnAttempts(root)).toBe(1);

        const claimed = locks.readMainSyncLock(root);
        expect(claimed?.pid).toBe(0);
        expect(claimed?.startedMs).toBeGreaterThanOrEqual(before);
    });

    it('launches nothing while a live refresher holds the lock past the interval but inside its hang window', () => {
        locks.writeMainSyncLock(root, new MainSyncLock(process.pid, Date.now() - (MIN_REFRESH_INTERVAL_MINUTES + 1) * MINUTE));
        triggerMainSyncRefresh(root, 30);
        expect(spawnAttempts(root)).toBe(0);
    });

    it('takes over a stale holder (past interval and hang window) and launches', () => {
        locks.writeMainSyncLock(root, new MainSyncLock(2147483646, Date.now() - 60 * MINUTE));
        triggerMainSyncRefresh(root, DEFAULT_HANG_TIMEOUT_MINUTES);
        expect(spawnAttempts(root)).toBe(1);
    });
});

/**
 * The detached child is a SEPARATE node process with a fresh, unidentified `logStream`. Until the
 * identity was put on its argv, the parent logged SPAWN_ATTEMPT to its own prefixed stream while the
 * child logged START/FINISH/ERROR to a shared, unidentified `unknown-coordinator-hook` writer —
 * one refresh cycle in two files, every agent's child appending to the same shared path (the PIPE_BUF
 * tearing LogStream exists to remove), and the documented "SPAWN_ATTEMPT with no START means the
 * child never launched" check reading as a false failure on every cycle.
 *
 * The bug is a disagreement about ARGV POSITIONS between two files, so both ends are pinned here at
 * once: a test of the reader alone would have stayed green through it.
 */
describe('the detached refresher inherits its spawner`s stream identity', () => {
    const IDENTITY = new StreamIdentity('sess-1', 'agent-9', 'guards');

    it('round-trips session/agent/hook from the spawn argv into the child`s LogStream', () => {
        const argv = refresherArgv('/x/sync-main.js', '/repo', 1234567, IDENTITY);
        // The child sees [execPath, script, ...argv] — the two-slot offset the positions depend on.
        expect(spawnerIdentity(['/usr/bin/node', ...argv])).toEqual(IDENTITY);
    });

    it('round-trips the lock claim`s started, which the child must match to adopt the lock', () => {
        const argv = refresherArgv('/x/sync-main.js', '/repo', 1234567, IDENTITY);
        expect(claimStartedFromArgv(['/usr/bin/node', ...argv])).toBe(1234567);
        // A hand-run with no claim matches no lock.
        expect(claimStartedFromArgv(['/usr/bin/node', '/x/sync-main.js', '/repo'])).toBeNaN();
    });

    it('makes parent and child name the SAME file, which is the whole point', () => {
        const parent = new LogStream();
        parent.identify(IDENTITY);
        const child = new LogStream();
        child.identify(spawnerIdentity(['/usr/bin/node', ...refresherArgv('/x.js', '/repo', 30, parent.identity())]));

        expect(child.writerFile('.log')).toBe(parent.writerFile('.log'));
        expect(child.writerFile('.log')).not.toContain('unknown-coordinator-hook');
    });

    it('still prefixes when the spawner never identified — a distinct stream, never a bare name', () => {
        const argv = refresherArgv('/x.js', '/repo', 30, new LogStream().identity());
        const child = new LogStream();
        child.identify(spawnerIdentity(['/usr/bin/node', ...argv]));
        expect(child.writerFile('.log')).toBe('unknown-coordinator-hook.log');
    });
});
