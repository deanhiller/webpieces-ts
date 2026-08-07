import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { triggerMainSyncRefresh, resetMainSyncRefreshLatchForTest, refresherArgv } from './main-sync-refresh';
import { spawnerIdentity } from './sync-main';

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

/**
 * The detached child is a SEPARATE node process with a fresh, unidentified `logStream`. Until the
 * identity was put on its argv, the parent logged SPAWN_ATTEMPT to its own prefixed stream while the
 * child logged START/FINISH/ERROR to the shared `unknown-coordinator-hook-guard-async-work.log` —
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
        const argv = refresherArgv('/x/sync-main.js', '/repo', 30, IDENTITY);
        // The child sees [execPath, script, ...argv] — the two-slot offset the positions depend on.
        expect(spawnerIdentity(['/usr/bin/node', ...argv])).toEqual(IDENTITY);
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
