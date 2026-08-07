import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LOGS_STATE_DIR } from '@webpieces/rules-config';

import { InvocationLog, logGuardDecision, GuardDecision } from './decision-log';
import { logSyncEvent, SyncLogEvent, syncStderrLogPath } from './main-sync-log';
import { logRejection } from './rejection-log';
import { NormalizedToolInput, NormalizedEdit, BlockedResult } from './types';

// Log FILENAMES now carry the stream prefix (see LogStream). Specs resolve the name the same way
// production does, so the layout is regression-tested on the REAL path rather than a fallback.
import { LogStream, StreamIdentity, logStream } from './log-stream';
function streamName(base: string): string { return new LogStream().fileName(base); }
// The process-wide stream is what production writes through, so a test that identifies it must put it
// back — otherwise the next test's filenames stop matching streamName()'s unidentified default.
const UNIDENTIFIED = new StreamIdentity('unknown', '', 'hook');


/**
 * ONE directory for logs — asserted over EVERY writer at once, not writer by writer.
 *
 * The layout drifted precisely because each writer spelled its own destination: the L1 binary's five
 * logs went to `hooks/` (which also held the dated, non-log rejection details) while the L0 sh shim
 * wrote to `logs/`. So "where are the logs?" had two answers, one of them a mixed directory. Every
 * writer now goes through `dotWebpieces.logs()`, and this file is the guard that keeps it that way:
 * it exercises each writer for real and then asserts, from the filesystem, that `.webpieces/` holds
 * `logs/` and nothing else. A newly-added writer that invents a second state directory turns this red.
 */
function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-loglayout-'));
}

function filesIn(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry: fs.Dirent): boolean => entry.isFile())
        .map((entry: fs.Dirent): string => entry.name);
}

// Fire every log writer in the package (plus the rules-config one, exercised via its own spec) once.
function exerciseEveryWriter(root: string): void {
    const invocations = new InvocationLog();
    invocations.begin(root, 'Bash', 'ls');
    invocations.finish('ALLOW', '-');

    logGuardDecision(root, new GuardDecision('bash-guard', 'Bash', 'gh pr create', 'dean/x', 'BLOCK', 'nope'));
    logSyncEvent(root, new SyncLogEvent('FINISH', 123, 'main', 'done'));

    const input = new NormalizedToolInput(path.join(root, 'src/x.ts'), [new NormalizedEdit('a', 'b')]);
    logRejection('Edit', input, new BlockedResult('[some-rule] (a reason)\nblocked'), root);
}

describe('every webpieces log lives under logs/, and nothing else does', () => {
    it('creates NO state directory besides logs/ — `hooks/` is gone and nothing recreates it', () => {
        const root = tmpRoot();
        exerciseEveryWriter(root);

        const state = fs.readdirSync(path.join(root, '.webpieces'));
        expect(state).toEqual([LOGS_STATE_DIR]);
        expect(fs.existsSync(path.join(root, '.webpieces', 'hooks'))).toBe(false);
    });

    it('puts all five of the binary-side logs in logs/', () => {
        const root = tmpRoot();
        exerciseEveryWriter(root);

        const logs = filesIn(path.join(root, '.webpieces', LOGS_STATE_DIR));
        for (const expected of [streamName('guard-invocations.log'), streamName('guard-sync-decisions.log'), streamName('guard-async-work.log'), streamName('hook-rejection.log')]) {
            expect(logs, `missing ${expected}`).toContain(expected);
        }
        // The refresher's raw stdout/stderr capture is a .log too, so it moved with the rest.
        expect(syncStderrLogPath(root)).toBe(path.join(root, '.webpieces', LOGS_STATE_DIR, streamName('guard-async-work.stderr.log')));
    });

    it('puts each rejection DETAIL in a directory named exactly like the log that indexes it', () => {
        const root = tmpRoot();
        exerciseEveryWriter(root);

        const logsDir = path.join(root, '.webpieces', LOGS_STATE_DIR);
        // Same stream identity as the index, minus the `.log` — which is the whole point: the detail
        // directory has ONE owner for the same reason the log does, so two agents blocked in the same
        // millisecond cannot write the same path.
        const detailDir = streamName('hook-rejection');
        expect(fs.existsSync(path.join(logsDir, detailDir))).toBe(true);
        expect(fs.readdirSync(path.join(logsDir, detailDir))).toHaveLength(1);
        expect(fs.readdirSync(path.join(logsDir, detailDir))[0]).toMatch(/^writeInfo-\d+\.md$/);

        // The pointer is relative to `logs/` — the index's OWN directory — so it resolves from where
        // the reader found the line.
        const index = fs.readFileSync(path.join(logsDir, streamName('hook-rejection.log')), 'utf8');
        expect(index).toContain(`\t${detailDir}/writeInfo-`);
        expect(fs.existsSync(path.join(logsDir, index.trim().split('\t')[4]))).toBe(true);
    });

    it('gives two DIFFERENT agents two different detail directories, so neither overwrites the other', () => {
        const root = tmpRoot();
        const input = new NormalizedToolInput(path.join(root, 'src/x.ts'), [new NormalizedEdit('a', 'b')]);
        const result = new BlockedResult('[some-rule] (a reason)\nblocked');

        // The collision this replaced: BOTH details were `hooks/<today>/writeInfo-<epochMs>.md`, so two
        // agents blocked in the same millisecond produced the same path and one silently vanished.
        logStream.identify(new StreamIdentity('sess', 'agentA', 'guards'));
        logRejection('Edit', input, result, root);
        logStream.identify(new StreamIdentity('sess', 'agentB', 'guards'));
        logRejection('Edit', input, result, root);
        logStream.identify(UNIDENTIFIED);

        const logsDir = path.join(root, '.webpieces', LOGS_STATE_DIR);
        for (const agent of ['agentA', 'agentB']) {
            const dir = path.join(logsDir, `sess-${agent}-guards-hook-rejection`);
            expect(fs.readdirSync(dir), `${agent} lost its detail`).toHaveLength(1);
        }
    });

    it('prunes details by the epoch millis IN THE FILENAME and removes the emptied stream dir', () => {
        const root = tmpRoot();
        const logsDir = path.join(root, '.webpieces', LOGS_STATE_DIR);
        const stale = path.join(logsDir, 'old-agent-guards-hook-rejection');
        fs.mkdirSync(stale, { recursive: true });
        // 8 days old, stated only in the NAME — no `stat` call, and no dated directory to key off.
        const old = `writeInfo-${String(Date.now() - 8 * 24 * 60 * 60 * 1000)}.md`;
        fs.writeFileSync(path.join(stale, old), 'ancient\n');

        exerciseEveryWriter(root);       // any rejection sweeps the whole logs dir

        expect(fs.existsSync(path.join(stale, old))).toBe(false);
        expect(fs.existsSync(stale)).toBe(false);           // emptied, so the directory went too
    });

    it('is idempotent — a second sweep over the same expired files changes nothing and throws nothing', () => {
        const root = tmpRoot();
        const logsDir = path.join(root, '.webpieces', LOGS_STATE_DIR);
        const stale = path.join(logsDir, 'old-agent-guards-hook-rejection');
        fs.mkdirSync(stale, { recursive: true });
        fs.writeFileSync(path.join(stale, `writeInfo-${String(Date.now() - 8 * 24 * 60 * 60 * 1000)}.md`), 'x\n');

        // Two agents racing the same week-old files is the normal case, not the exceptional one.
        exerciseEveryWriter(root);
        exerciseEveryWriter(root);

        expect(fs.existsSync(stale)).toBe(false);
        expect(filesIn(logsDir).filter((n: string): boolean => n.endsWith('.log')).length).toBeGreaterThan(0);
    });
});
