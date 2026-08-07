import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { LogStream, StreamIdentity } from './log-stream';
import { dotWebpieces } from '@webpieces/rules-config';
import { L1_LOCATION_STREAM, CALLS_STREAM } from './log-streams';

/**
 * The property under test is CONCURRENCY SAFETY, and it is structural: two writers must never resolve
 * to the same file. `O_APPEND` is indivisible only under PIPE_BUF (512 bytes on macOS), and
 * measured 2026-08-06 across three repos, 6.3% of the invocation stream's lines already exceed that —
 * so a shared file tears in practice, not just in theory.
 *
 * The layout is `logs/<stream>/<sessionId>-<agentId|coordinator>-<hook>.log`: the STREAM is the
 * directory (which layer wrote it) and the WRITER is the file (who wrote it). Only the second half is
 * this class's job, and all three of its dimensions stay in the filename — dropping `hook` in
 * particular would put the parallel guards and rules hooks on one path.
 */
const ROOT = path.join('/tmp', 'wp-log-stream-root');

// The full path of one log file for this identity — that is what must be unique per writer.
function pathOf(sessionId: string, agentId: string, hook: string): string {
    const s = new LogStream();
    s.identify(new StreamIdentity(sessionId, agentId, hook));
    return path.join(dotWebpieces.logsFile(ROOT, CALLS_STREAM), s.writerFile('.log'));
}

describe('LogStream keeps every concurrent writer in its own file', () => {
    // The two hooks Claude Code runs IN PARALLEL on every Write/Edit. This is the collision that
    // exists today, before any subagent or second window is involved — and it is why `hook` cannot
    // move out of the filename when the stream moves into the directory.
    it('separates the guards hook from the rules hook', () => {
        expect(pathOf('s1', '', 'guards')).not.toBe(pathOf('s1', '', 'rules'));
    });

    // agent_id is absent for the coordinator, so four Claude Code windows are four indistinguishable
    // coordinators — session_id is the only thing that tells them apart.
    it('separates four coordinators that all lack an agent id', () => {
        const paths = ['s1', 's2', 's3', 's4'].map((s: string): string => pathOf(s, '', 'guards'));
        expect(new Set(paths).size).toBe(4);
    });

    it('separates subagents within one session', () => {
        expect(pathOf('s1', 'a1', 'guards')).not.toBe(pathOf('s1', 'a2', 'guards'));
    });

    it('separates a subagent from its own coordinator', () => {
        expect(pathOf('s1', 'a1', 'guards')).not.toBe(pathOf('s1', '', 'guards'));
    });

    // The whole 12-agent scenario at once: 4 windows x (1 coordinator + 2 subagents) x 2 hooks.
    it('gives 24 distinct files to 4 sessions x 3 agents x 2 hooks', () => {
        const paths: string[] = [];
        for (const s of ['s1', 's2', 's3', 's4']) {
            for (const a of ['', 'a1', 'a2']) {
                for (const h of ['guards', 'rules']) paths.push(pathOf(s, a, h));
            }
        }
        expect(new Set(paths).size).toBe(24);
    });

    it('names the coordinator explicitly rather than leaving an empty field', () => {
        expect(pathOf('s1', '', 'guards')).toContain('s1-coordinator-guards.log');
    });

    it('names the writer by its three identity dimensions and nothing else', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('sess1', 'agentA', 'guards'));
        expect(s.writerFile('.log')).toBe('sess1-agentA-guards.log');
    });

    // Rotation must keep working: the sibling gets the identical writer key because the SUFFIX is
    // what varies, not the key.
    it('gives the rotation sibling the same writer key', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('sess1', '', 'guards'));
        expect(s.writerFile('.1.log')).toBe('sess1-coordinator-guards.1.log');
    });

    // The rejection DETAIL directory is the same key with no extension, so index and details share
    // one owner.
    it('gives the extensionless form for a detail directory', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('sess1', 'agentA', 'guards'));
        expect(s.writerFile('')).toBe('sess1-agentA-guards');
    });
});

describe('the stream directory carries the LAYER, so one glob selects one layer', () => {
    // The question that had no answer before: L1 wrote into L2's file, so "show me every L1 decision"
    // could not be asked. Now the layer IS the directory.
    it('puts two layers written by ONE writer in two different directories', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('s1', 'a1', 'guards'));
        const l1 = path.join(dotWebpieces.logsFile(ROOT, L1_LOCATION_STREAM), s.writerFile('.log'));
        const calls = path.join(dotWebpieces.logsFile(ROOT, CALLS_STREAM), s.writerFile('.log'));
        expect(path.dirname(l1)).not.toBe(path.dirname(calls));
        expect(path.basename(l1)).toBe(path.basename(calls));
    });

    it('keeps every stream directory under the ONE logs directory', () => {
        for (const stream of [CALLS_STREAM, L1_LOCATION_STREAM]) {
            expect(path.dirname(dotWebpieces.logsFile(ROOT, stream))).toBe(dotWebpieces.logs(ROOT));
        }
    });
});

describe('LogStream has NO un-split path', () => {
    // The bare name was two reachable spellings of one filename, with the TEARING one reached by a
    // writer doing nothing. Deleted, not deferred: there is no unkeyed()/reset() and no bare branch.
    it('names even a brand-new, never-identified stream', () => {
        expect(new LogStream().writerFile('.log')).toBe('unknown-coordinator-hook.log');
    });

    it('renders an empty session id as `unknown` rather than falling back', () => {
        expect(path.basename(pathOf('', 'a1', 'guards'))).toBe('unknown-a1-guards.log');
    });

    it('never returns a bare filename to anyone', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('', '', ''));
        expect(s.writerFile('.log')).not.toBe('.log');
        expect(s.writerFile('.log')).toBe('unknown-coordinator-unknown.log');
    });
});

describe('LogStream treats payload ids as UNTRUSTED path input', () => {
    // session_id and agent_id arrive from JSON. A traversal must become a harmless name, not escape.
    it('cannot be walked out of the stream directory', () => {
        const escaped = pathOf('../../../../etc', '../../root', 'guards');
        expect(escaped).not.toContain('..');
        expect(path.dirname(escaped)).toBe(dotWebpieces.logsFile(ROOT, CALLS_STREAM));
    });

    it('neutralises a leading dot so nothing becomes a hidden file', () => {
        expect(path.basename(pathOf('.ssh', '', 'guards')).startsWith('.')).toBe(false);
    });

    it('collapses separators and exotic characters', () => {
        expect(pathOf('a/b\\c d', '', 'guards')).toContain('a_b_c_d');
    });

    it('caps a hostile length', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('x'.repeat(500), '', 'guards'));
        expect(s.writerFile('.log').split('-')[0].length).toBeLessThanOrEqual(64);
    });

    it('never produces an empty field', () => {
        const s = new LogStream();
        s.identify(new StreamIdentity('///', '', 'guards'));
        expect(s.writerFile('.log').startsWith('-')).toBe(false);
    });
});
