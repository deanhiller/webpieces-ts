import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    AGENT_ACTIVITY_LIVE,
    AGENT_ACTIVITY_RETURNED,
    AGENT_ACTIVITY_UNKNOWN,
    AGENT_TRANSCRIPT_QUIET_MS,
    HarnessAgentActivityReader,
} from './harness-agent-activity';

/**
 * Against FIXTURE transcripts written by this file, never against the real `~/.claude`.
 *
 * The layout is somebody else's and undocumented, so a spec that reads the live tree would assert
 * whatever happens to be on the machine that day — green on the author's box, meaningless everywhere
 * else, and untestable for the cases that matter (a killed agent, a truncated line). Every shape
 * below was OBSERVED in a real transcript first and is reproduced here byte-for-byte in structure.
 *
 * `$CLAUDE_CONFIG_DIR` is how the harness itself relocates that tree, so pointing it at a temp
 * directory exercises the same resolution the field uses rather than a test-only seam.
 */

let configDir = '';
let subagents = '';
let originalConfigDir: string | undefined;

const WORKTREE = '/repo/.claude/worktrees/agent-a1';

function record(type: string, blocks: string[]): string {
    const content = blocks.map((kind: string): string => `{"type":"${kind}"}`).join(',');
    return JSON.stringify(JSON.parse(`{"type":"${type}","message":{"content":[${content}]}}`));
}

/** One agent on disk: its meta (which is what maps id → worktree) and its transcript. */
function writeAgent(id: string, worktreePath: string, lines: string[]): void {
    writeFileSync(join(subagents, `${id}.meta.json`),
        JSON.stringify({ agentType: 'general-purpose', worktreePath, spawnedWithWorktree: true }), 'utf8');
    writeFileSync(join(subagents, `${id}.jsonl`), lines.join('\n') + '\n', 'utf8');
}

beforeEach((): void => {
    configDir = mkdtempSync(join(tmpdir(), 'harness-state-'));
    subagents = join(configDir, 'projects', '-repo', 'session-1', 'subagents');
    mkdirSync(subagents, { recursive: true });
    originalConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = configDir;
});

afterEach((): void => {
    if (originalConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = originalConfigDir;
    rmSync(configDir, { recursive: true, force: true });
});

/**
 * The loop terminates when the model emits text and asks for no tool. That is the definition of the
 * harness loop, which is what makes it exact rather than a correlation — and it is the ONLY thing
 * that can lift the veto this class exists to apply.
 */
describe('a transcript that ends with the agent RETURNING', (): void => {
    it('reads a text-only assistant record as returned', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['tool_use']), record('assistant', ['text'])]);

        const activity = new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE);

        expect(activity.state).toBe(AGENT_ACTIVITY_RETURNED);
    });

    // Observed: `thinking` blocks sit alongside `text`. The criterion is the ABSENCE of `tool_use`,
    // never "exactly one block" — a spec that pinned the block count would fail on every thinking model.
    it('reads thinking + text as returned', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['thinking', 'text'])]);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_RETURNED);
    });

    // Returned is NOT "done forever": the harness re-invokes an agent when a background child it
    // started finishes, or when its parent messages it. That is survivable only because this class
    // may never license a reap — see the file header — so the state is deliberately named RETURNED
    // rather than FINISHED, and nothing here promises otherwise.
    it('does not claim the agent is finished for good', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['text'])]);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).detail)
            .not.toContain('finished');
    });
});

describe('a transcript that ends MID-LOOP', (): void => {
    it('reads a tool_use as live while the file is fresh', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['tool_use'])]);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_LIVE);
    });

    // Text ALONGSIDE a tool_use is the model narrating before it calls something. Not a return.
    it('reads text + tool_use as live, not as a return', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['text', 'tool_use'])]);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_LIVE);
    });

    it('reads a tool_result coming back as live', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('user', ['tool_result'])]);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_LIVE);
    });

    /**
     * Observed on a resumed agent: a `user` record's content is sometimes a plain STRING rather than
     * a list of blocks. It must read as mid-loop and must not throw — a crash here would take down
     * wp-cleanup over one malformed-looking line in somebody else's file.
     */
    it('survives a user record whose content is a plain string', (): void => {
        writeAgent('agent-a1', WORKTREE, ['{"type":"user","message":{"content":"go on then"}}']);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_LIVE);
    });

    /**
     * THE CASE MTIME EXISTS FOR, and the only one. An agent killed inside a tool call leaves a
     * `tool_use` last record forever, which is the original "looks live forever" defect. After the
     * quiet window the veto lapses — to UNKNOWN, not to a reap: the branch evidence still has to
     * agree before anything is removed.
     */
    it('lapses to unknown once a mid-loop transcript has been silent for a long time', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['tool_use'])]);

        const later = Date.now() + AGENT_TRANSCRIPT_QUIET_MS + 60000;
        const activity = new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE, later);

        expect(activity.state).toBe(AGENT_ACTIVITY_UNKNOWN);
        expect(activity.detail).toContain('killed');
    });
});

describe('everything unreadable fails to UNKNOWN, never to returned', (): void => {
    it('reports unknown when the last line is truncated garbage', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['text']), '{"type":"assist']);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_UNKNOWN);
    });

    /**
     * THREE different silences, three different sentences. They used to share one — "the harness has
     * no state file for that agent id" — which was true of only the first, and that string is printed
     * verbatim into wp-cleanup's reason. A message asserting more than the evidence supports is the
     * exact defect this file exists to remove; it does not get a pass for being small.
     */
    it('says the state file is ABSENT when nothing names that agent', (): void => {
        const activity = new HarnessAgentActivityReader().activityOf('agent-nobody', WORKTREE);

        expect(activity.state).toBe(AGENT_ACTIVITY_UNKNOWN);
        expect(activity.detail).toContain('no state file');
    });

    it('says the state file is UNREADABLE when it is there but will not parse', (): void => {
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['text'])]);
        writeFileSync(join(subagents, 'agent-a1.meta.json'), '{ not json', 'utf8');

        const activity = new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE);

        expect(activity.state).toBe(AGENT_ACTIVITY_UNKNOWN);
        expect(activity.detail).toContain('could not be read');
        expect(activity.detail).not.toContain('no state file');
    });

    it('reports unknown when the transcript is empty', (): void => {
        writeAgent('agent-a1', WORKTREE, []);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_UNKNOWN);
    });

    it('reports unknown when the whole config directory is missing', (): void => {
        process.env['CLAUDE_CONFIG_DIR'] = join(configDir, 'nope');

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_UNKNOWN);
    });

    /**
     * The worktree cross-check is what makes this a LOOKUP and not a guess. A meta that names a
     * DIFFERENT directory means we matched the wrong thing, and an answer about somebody else's
     * worktree is worse than no answer.
     */
    it('refuses to answer when the meta records a different worktree, and says THAT', (): void => {
        const elsewhere = '/repo/.claude/worktrees/agent-SOMEBODY-ELSE';
        writeAgent('agent-a1', elsewhere, [record('assistant', ['text'])]);

        const activity = new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE);

        expect(activity.state).toBe(AGENT_ACTIVITY_UNKNOWN);
        expect(activity.detail).toContain(elsewhere);
        expect(activity.detail).not.toContain('no state file');
    });
});

// An agent's state lives under the session that SPAWNED it, which is not necessarily the newest one,
// so every session directory is searched rather than a guessed-at slug.
describe('finding an agent across sessions', (): void => {
    it('finds state under a session other than the first one scanned', (): void => {
        const other = join(configDir, 'projects', '-other-repo', 'session-9', 'subagents');
        mkdirSync(other, { recursive: true });
        subagents = other;
        writeAgent('agent-a1', WORKTREE, [record('assistant', ['text'])]);

        expect(new HarnessAgentActivityReader().activityOf('agent-a1', WORKTREE).state)
            .toBe(AGENT_ACTIVITY_RETURNED);
    });
});
