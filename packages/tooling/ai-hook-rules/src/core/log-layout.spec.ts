import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOOKS_STATE_DIR, LOGS_STATE_DIR } from '@webpieces/rules-config';

import { InvocationLog, logGuardDecision, GuardDecision } from './decision-log';
import { logSyncEvent, SyncLogEvent, syncStderrLogPath } from './main-sync-log';
import { logRejection } from './rejection-log';
import { NormalizedToolInput, NormalizedEdit, BlockedResult } from './types';

// Log FILENAMES now carry the stream prefix (see LogStream). Specs resolve the name the same way
// production does, so the layout is regression-tested on the REAL path rather than a fallback.
import { LogStream } from './log-stream';
function streamName(base: string): string { return new LogStream().fileName(base); }


/**
 * ONE directory for logs — asserted over EVERY writer at once, not writer by writer.
 *
 * The layout drifted precisely because each writer spelled its own destination: the L1 binary's five
 * logs went to `hooks/` (which also holds the dated, non-log rejection details) while the L0 sh shim
 * wrote to `logs/`. So "where are the logs?" had two answers, one of them a mixed directory. Every
 * writer now goes through `dotWebpieces.logs()`, and this file is the guard that keeps it that way:
 * it exercises each writer for real and then asserts, from the filesystem, that `hooks/` contains no
 * `.log` at all. A newly-added writer that reaches for `hooks/` again turns this red.
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
    it('writes no .log under hooks/ from ANY writer', () => {
        const root = tmpRoot();
        exerciseEveryWriter(root);

        const hooksDir = path.join(root, '.webpieces', HOOKS_STATE_DIR);
        expect(filesIn(hooksDir).filter((name: string): boolean => name.endsWith('.log'))).toEqual([]);
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

    it('keeps the NON-log rejection details in hooks/, and keeps the index pointing at them', () => {
        const root = tmpRoot();
        exerciseEveryWriter(root);

        const dated = fs.readdirSync(path.join(root, '.webpieces', HOOKS_STATE_DIR));
        expect(dated).toHaveLength(1);                       // one dated directory, no stray log file
        expect(dated[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // The index moved to logs/ while the detail stayed in hooks/, so the pointer has to be
        // relative to the STATE DIR — a bare `<date>/<file>` would no longer resolve.
        const index = fs.readFileSync(path.join(root, '.webpieces', LOGS_STATE_DIR, streamName('hook-rejection.log')), 'utf8');
        expect(index).toContain(`\t${HOOKS_STATE_DIR}/${dated[0]}/writeInfo-`);
        expect(fs.existsSync(path.join(root, '.webpieces', index.trim().split('\t')[4]))).toBe(true);
    });
});
