import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DotWebpieces, agentDirName, AGENTS_STATE_DIR, LOGS_STATE_DIR } from './state-dir';

/**
 * PER-AGENT log separation — `<logs>/agents/<agentId>/`.
 *
 * THE BUG: a subagent WITHOUT worktree isolation shares the coordinator's checkout, and the hook is
 * wired at `$CLAUDE_PROJECT_DIR`, fixed at session start. One coordinator plus several such subagents
 * therefore appended to ONE guard-invocations.log, and interleaved lines cannot be untangled after the
 * fact. (A worktree-isolated subagent was already separated by local().)
 *
 * The two properties this file exists to hold are in tension, which is why they are asserted together:
 * the coordinator's paths must not move AT ALL (every habit and every grep keeps working), and a
 * subagent's id — which arrives in a payload, i.e. it is INPUT — must never be able to name a path
 * outside the log directory.
 */
function tmpRoot(): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agentlogs-')));
}

describe('DotWebpieces.agentLogs — the coordinator does not move', () => {
    it('resolves an EMPTY agent id to exactly today\'s log directory', () => {
        const root = tmpRoot();
        const dot = new DotWebpieces();
        expect(dot.agentLogs(root, '')).toBe(dot.logs(root));
        expect(dot.agentLogs(root, '')).toBe(path.join(root, '.webpieces', LOGS_STATE_DIR));
    });

    it('gives two different agents two different directories, under the same logs/', () => {
        const root = tmpRoot();
        const dot = new DotWebpieces();
        const one = dot.agentLogs(root, 'agent-aaa');
        const two = dot.agentLogs(root, 'agent-bbb');

        expect(one).not.toBe(two);
        expect(one).toBe(path.join(dot.logs(root), AGENTS_STATE_DIR, 'agent-aaa'));
        expect(path.dirname(path.dirname(one))).toBe(dot.logs(root));
    });

    // The filenames INSIDE the namespace are the same filenames, which is what keeps rotation
    // (`<name>.1.log`) working in there without a second implementation.
    it('keeps the same filenames inside the namespace, so rotation is unchanged', () => {
        const root = tmpRoot();
        const dot = new DotWebpieces();
        expect(path.basename(path.join(dot.agentLogs(root, 'a1'), 'guard-invocations.log')))
            .toBe(path.basename(path.join(dot.logs(root), 'guard-invocations.log')));
    });
});

/**
 * A HOSTILE id is neutralised into a directory NAME, never rejected into someone else's stream —
 * rejecting it would merge that agent's lines back into the coordinator's file, which is the bug.
 */
describe('agentDirName — a payload value can never escape the logs directory', () => {
    const hostile = ['..', '../..', '../../../../etc/passwd', '/etc/passwd', 'a/b', 'a\\b', '.', './x'];

    it('collapses every traversal spelling to ONE harmless segment', () => {
        for (const id of hostile) {
            const name = agentDirName(id);
            expect(name, `sanitised ${id}`).not.toContain('/');
            expect(name, `sanitised ${id}`).not.toContain('\\');
            expect(['.', '..'], `sanitised ${id}`).not.toContain(name);
        }
    });

    it('keeps the resolved path INSIDE logs/agents for every hostile id', () => {
        const root = tmpRoot();
        const dot = new DotWebpieces();
        const agentsDir = path.join(dot.logs(root), AGENTS_STATE_DIR);
        for (const id of hostile) {
            const resolved = path.resolve(dot.agentLogs(root, id));
            expect(resolved.startsWith(agentsDir + path.sep), `${id} -> ${resolved}`).toBe(true);
        }
    });

    it('caps the length, so a 400-character id cannot blow a path limit', () => {
        expect(agentDirName('x'.repeat(400)).length).toBe(64);
    });

    it('leaves an ordinary id alone (the common case must stay readable)', () => {
        expect(agentDirName('agent_a4acb95-835')).toBe('agent_a4acb95-835');
    });
});
