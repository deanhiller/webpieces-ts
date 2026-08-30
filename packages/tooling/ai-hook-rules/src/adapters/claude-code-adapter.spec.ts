import { describe, it, expect } from 'vitest';

import { ClaudeCodeAdapter } from './claude-code-adapter';
import { FileOperation } from '../core/agent-event';

/**
 * The Claude Code mapping, pinned where it now lives.
 *
 * These are the exact behaviours `normalizeToolKind` / `normalizeToolInput` had inside hook-core before
 * they moved here, including the awkward ones: `content`/`old_string`/`new_string` defaulting to '',
 * a non-array `edits` degrading to no edits, and a file tool with no `file_path` ending up ALLOWED
 * rather than blocked. None of them are improvements waiting to happen — they are the harness every
 * developer uses today, and moving any of them is the regression this file exists to catch.
 */
const adapter = new ClaudeCodeAdapter();

function op(files: readonly FileOperation[]): FileOperation {
    expect(files).toHaveLength(1);
    return files[0];
}

describe('ClaudeCodeAdapter', () => {
    it('maps Write to one edit of content against an empty old string', () => {
        const e = adapter.toEvent({ tool_name: 'Write', tool_input: { file_path: '/r/a.ts', content: 'hello' } }, '/r');
        expect(e.aiType).toBe('claude-code');
        expect(e.kind).toBe('File');
        expect(op(e.files).toolKind).toBe('Write');
        expect(op(e.files).input.filePath).toBe('/r/a.ts');
        expect(op(e.files).input.edits[0].oldString).toBe('');
        expect(op(e.files).input.edits[0].newString).toBe('hello');
    });

    it('maps Edit to one old→new edit', () => {
        const e = adapter.toEvent({ tool_name: 'Edit', tool_input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } }, '/r');
        expect(op(e.files).toolKind).toBe('Edit');
        expect(op(e.files).input.edits).toHaveLength(1);
        expect(op(e.files).input.edits[0].oldString).toBe('a');
        expect(op(e.files).input.edits[0].newString).toBe('b');
    });

    it('maps MultiEdit to one edit per entry', () => {
        const e = adapter.toEvent({
            tool_name: 'MultiEdit',
            tool_input: { file_path: '/r/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { new_string: 'c' }] },
        }, '/r');
        expect(op(e.files).toolKind).toBe('MultiEdit');
        expect(op(e.files).input.edits).toHaveLength(2);
        expect(op(e.files).input.edits[1].oldString).toBe('');
        expect(op(e.files).input.edits[1].newString).toBe('c');
    });

    it('defaults missing content / old_string / new_string to an empty string', () => {
        const w = adapter.toEvent({ tool_name: 'Write', tool_input: { file_path: '/r/a.ts' } }, '/r');
        expect(op(w.files).input.edits[0].newString).toBe('');
        const ed = adapter.toEvent({ tool_name: 'Edit', tool_input: { file_path: '/r/a.ts' } }, '/r');
        expect(op(ed.files).input.edits[0].oldString).toBe('');
        expect(op(ed.files).input.edits[0].newString).toBe('');
    });

    it('degrades a file tool with NO file_path to Ignored — allowed, exactly as before', () => {
        const e = adapter.toEvent({ tool_name: 'Write', tool_input: { content: 'hello' } }, '/r');
        expect(e.kind).toBe('Ignored');
        expect(e.files).toEqual([]);
    });

    it('maps Bash to a Bash event with no files and NO synthesized reads', () => {
        const e = adapter.toEvent({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }, '/r');
        expect(e.kind).toBe('Bash');
        expect(e.bash!.command).toBe('ls -la');
        expect(e.files).toEqual([]);
        expect(e.reads).toEqual([]);
    });

    it('maps every other tool to Ignored', () => {
        for (const tool of ['Grep', 'Glob', 'WebFetch', 'Task']) {
            expect(adapter.toEvent({ tool_name: tool, tool_input: {} }, '/r').kind).toBe('Ignored');
        }
    });

    it('carries the identity fields through, empty when absent', () => {
        const bare = adapter.toEvent({ tool_name: 'Bash', tool_input: { command: 'ls' } }, '/r');
        expect([bare.sessionId, bare.agentId, bare.agentType]).toEqual(['', '', '']);
        const full = adapter.toEvent(
            { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's', agent_id: 'a', agent_type: 'general' }, '/r');
        expect([full.sessionId, full.agentId, full.agentType]).toEqual(['s', 'a', 'general']);
    });

    it('envelope() reads the tool name WITHOUT touching tool_input, so a crash deny still knows the kind', () => {
        // The payload the crash path sees: tool_input absent entirely. envelope() must not throw.
        // webpieces-disable no-any-unknown -- deliberately malformed wire payload, the case under test
        const malformed = { tool_name: 'Bash' } as any;
        expect(adapter.envelope(malformed).kind).toBe('Bash');
        expect(adapter.envelope({ tool_name: 'Write', tool_input: {} }).kind).toBe('File');
        expect(adapter.envelope({ tool_name: 'Read', tool_input: {} }).kind).toBe('Read');
    });
});
