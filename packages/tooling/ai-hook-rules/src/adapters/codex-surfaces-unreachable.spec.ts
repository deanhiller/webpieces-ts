import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentAdapters } from './agent-adapters';
import { ClaudeCodeAdapter } from './claude-code-adapter';
import { CodexAdapter } from './codex-adapter';
import { CodexSubagentSharedTreeGuard } from './codex-subagent-guard';
import { AgentHookEvent, FileOperation } from '../core/agent-event';
import { NormalizedToolInput } from '../core/types';

/**
 * CLAUDE CODE MUST NOT BE ABLE TO REACH THE CODEX SURFACES.
 *
 * Two of them are new guard surfaces that can DENY — shell read-parity (which runs the read guard on a
 * shell command) and the shared-tree subagent guard. If either could fire on a Claude Code payload, the
 * harness every developer uses today would acquire a new way to be blocked. This file is the proof that
 * it cannot, asserted at the adapter boundary where the gate actually lives.
 */
let root = '';
let file = '';

beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-codex-gate-')));
    file = path.join(root, 'a.ts');
    fs.writeFileSync(file, 'a\n');
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('read parity is unreachable from Claude Code', () => {
    it('leaves reads EMPTY for a Claude Bash payload that is textbook read-shaped', () => {
        const event = new ClaudeCodeAdapter().toEvent(
            { tool_name: 'Bash', tool_input: { command: `sed -n '1,240p' ${file}` } }, root);
        expect(event.aiType).toBe('claude-code');
        expect(event.kind).toBe('Bash');
        expect(event.reads).toEqual([]);
    });

    it('routes the SAME command to reads for Codex', () => {
        const event = new CodexAdapter().toEvent(
            { tool_name: 'Bash', tool_input: { command: `sed -n '1,240p' ${file}` }, turn_id: 't1' }, root);
        expect(event.aiType).toBe('codex');
        expect(event.reads).toEqual([file]);
    });

    it('dispatches by turn_id alone — the same tool_input, two harnesses, two answers', () => {
        const adapters = new AgentAdapters();
        const toolInput = { command: `cat ${file}` };
        expect(adapters.toEvent({ tool_name: 'Bash', tool_input: toolInput }, root).reads).toEqual([]);
        expect(adapters.toEvent({ tool_name: 'Bash', tool_input: toolInput, turn_id: 't1' }, root).reads).toEqual([file]);
    });

    it('populates reads for a Claude Read payload only from its own Read tool', () => {
        const event = new ClaudeCodeAdapter().toEvent({ tool_name: 'Read', tool_input: { file_path: file } }, root);
        expect(event.kind).toBe('Read');
        expect(event.reads).toEqual([file]);
    });
});

describe('codex-subagent-no-write-in-shared-tree is unreachable from Claude Code', () => {
    const guard = new CodexSubagentSharedTreeGuard();

    function event(aiType: 'claude-code' | 'codex', agentId: string, filePath: string): AgentHookEvent {
        return new AgentHookEvent(
            aiType, 'File', aiType === 'codex' ? 'apply_patch' : 'Write', root, 's1', agentId, 'default',
            [new FileOperation('Write', new NormalizedToolInput(filePath, []))], null, []);
    }

    it('never fires on a Claude Code subagent, even writing into the shared tree', () => {
        expect(guard.check(event('claude-code', 'agent-1', file), root)).toBeNull();
    });

    it('never fires on the Codex COORDINATOR (empty agent_id)', () => {
        expect(guard.check(event('codex', '', file), root)).toBeNull();
    });

    it('never fires on a Codex subagent writing OUTSIDE the shared tree', () => {
        expect(guard.check(event('codex', 'agent-1', '/somewhere/else/a.ts'), root)).toBeNull();
    });

    it('DENIES a Codex subagent writing into the shared tree, and teaches the worktree cure', () => {
        const blocked = guard.check(event('codex', 'agent-1', file), root);
        expect(blocked).not.toBeNull();
        expect(blocked!.report).toContain('git worktree add');
        expect(blocked!.report).toContain('ABSOLUTE');
        expect(blocked!.report).toContain('a.ts');
    });
});

describe('the Codex adapter ignores every tool it cannot judge', () => {
    it.each(['webrun', 'collaborationspawn_agent', 'collaborationwait_agent', 'view_image', 'update_plan', 'some_future_mcp_tool'])(
        'maps %s to Ignored with nothing to judge', (toolName: string) => {
            const event = new CodexAdapter().toEvent({ tool_name: toolName, tool_input: {}, turn_id: 't1' }, root);
            expect(event.kind).toBe('Ignored');
            expect(event.files).toEqual([]);
            expect(event.bash).toBeNull();
            expect(event.reads).toEqual([]);
        });

    it('maps apply_patch to a File event carrying every file the patch touches', () => {
        const command = '*** Begin Patch\n*** Add File: x.txt\n+x\n*** Delete File: y.txt\n*** End Patch';
        const event = new CodexAdapter().toEvent({ tool_name: 'apply_patch', tool_input: { command }, turn_id: 't1' }, root);
        expect(event.kind).toBe('File');
        expect(event.files.map((f: FileOperation): string => f.toolKind)).toEqual(['Write', 'Delete']);
    });
});
