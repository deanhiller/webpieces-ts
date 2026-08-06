import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { LogStream } from './log-stream';
import { dotWebpieces } from '@webpieces/rules-config';

/**
 * The property under test is CONCURRENCY SAFETY, and it is structural: two writers must never resolve
 * to the same directory. `O_APPEND` is indivisible only under PIPE_BUF (512 bytes on macOS), and
 * measured 2026-08-06 across three repos, 6.3% of `guard-invocations.log` lines already exceed that —
 * so a shared file tears in practice, not just in theory.
 */
const ROOT = path.join('/tmp', 'wp-log-stream-root');

// The full path of one log file for this identity — that is what must be unique per writer.
function dirOf(sessionId: string, agentId: string, hook: string): string {
    const s = new LogStream();
    s.identify(sessionId, agentId, hook);
    return path.join(dotWebpieces.logs(ROOT), s.fileName('guard-invocations.log'));
}

describe('LogStream keeps every concurrent writer in its own directory', () => {
    // The two hooks Claude Code runs IN PARALLEL on every Write/Edit. This is the collision that
    // exists today, before any subagent or second window is involved.
    it('separates the guards hook from the rules hook', () => {
        expect(dirOf('s1', '', 'guards')).not.toBe(dirOf('s1', '', 'rules'));
    });

    // agent_id is absent for the coordinator, so four Claude Code windows are four indistinguishable
    // coordinators — session_id is the only thing that tells them apart.
    it('separates four coordinators that all lack an agent id', () => {
        const dirs = ['s1', 's2', 's3', 's4'].map((s: string): string => dirOf(s, '', 'guards'));
        expect(new Set(dirs).size).toBe(4);
    });

    it('separates subagents within one session', () => {
        expect(dirOf('s1', 'a1', 'guards')).not.toBe(dirOf('s1', 'a2', 'guards'));
    });

    it('separates a subagent from its own coordinator', () => {
        expect(dirOf('s1', 'a1', 'guards')).not.toBe(dirOf('s1', '', 'guards'));
    });

    // The whole 12-agent scenario at once: 4 windows x (1 coordinator + 2 subagents) x 2 hooks.
    it('gives 24 distinct directories to 4 sessions x 3 agents x 2 hooks', () => {
        const dirs: string[] = [];
        for (const s of ['s1', 's2', 's3', 's4']) {
            for (const a of ['', 'a1', 'a2']) {
                for (const h of ['guards', 'rules']) dirs.push(dirOf(s, a, h));
            }
        }
        expect(new Set(dirs).size).toBe(24);
    });

    it('names the coordinator explicitly rather than leaving an empty field', () => {
        expect(dirOf('s1', '', 'guards')).toContain('s1-coordinator-guards-guard-invocations.log');
    });

    // The whole point of flat over nested: one glob answers each question.
    it('keeps every stream in ONE directory so a glob can select any slice', () => {
        const s = new LogStream();
        s.identify('sess1', 'agentA', 'guards');
        expect(s.fileName('guard-invocations.log')).toBe('sess1-agentA-guards-guard-invocations.log');
    });

    // Rotation must keep working: the sibling gets the identical prefix because the WHOLE filename
    // is passed through fileName(), not just a stem.
    it('gives the rotation sibling the same prefix', () => {
        const s = new LogStream();
        s.identify('sess1', '', 'guards');
        expect(s.fileName('guard-invocations.1.log')).toBe('sess1-coordinator-guards-guard-invocations.1.log');
    });
});

describe('LogStream has NO un-split path', () => {
    // The bare name was two reachable spellings of one filename, with the TEARING one reached by a
    // writer doing nothing. Deleted, not deferred: there is no unkeyed()/reset() and no bare branch.
    it('prefixes even a brand-new, never-identified stream', () => {
        expect(new LogStream().fileName('guard-invocations.log'))
            .toBe('unknown-coordinator-hook-guard-invocations.log');
    });

    it('renders an empty session id as `unknown` rather than falling back', () => {
        expect(path.basename(dirOf('', 'a1', 'guards'))).toBe('unknown-a1-guards-guard-invocations.log');
    });

    it('never returns the historical bare filename to anyone', () => {
        const s = new LogStream();
        s.identify('', '', '');
        expect(s.fileName('guard-invocations.log')).not.toBe('guard-invocations.log');
    });

    it('puts every stream in the ONE shared logs directory', () => {
        const s = new LogStream();
        s.identify('s1', 'a1', 'guards');
        expect(path.dirname(path.join(dotWebpieces.logs(ROOT), s.fileName('x.log')))).toBe(dotWebpieces.logs(ROOT));
    });
});

describe('LogStream treats payload ids as UNTRUSTED path input', () => {
    // session_id and agent_id arrive from JSON. A traversal must become a harmless name, not escape.
    it('cannot be walked out of the logs directory', () => {
        const escaped = dirOf('../../../../etc', '../../root', 'guards');
        expect(escaped).not.toContain('..');
        expect(path.dirname(escaped)).toBe(dotWebpieces.logs(ROOT));
    });

    it('neutralises a leading dot so nothing becomes a hidden file', () => {
        expect(path.basename(dirOf('.ssh', '', 'guards')).startsWith('.')).toBe(false);
    });

    it('collapses separators and exotic characters', () => {
        expect(dirOf('a/b\\c d', '', 'guards')).toContain('a_b_c_d');
    });

    it('caps a hostile length', () => {
        const s = new LogStream();
        s.identify('x'.repeat(500), '', 'guards');
        expect(s.fileName('a.log').split('-')[0].length).toBeLessThanOrEqual(64);
    });

    it('never produces an empty field', () => {
        const s = new LogStream();
        s.identify('///', '', 'guards');
        expect(s.fileName('a.log').startsWith('-')).toBe(false);
    });
});
