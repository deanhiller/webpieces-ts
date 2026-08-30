import { AgentPayload, AgentToolInput, AgentEditEntry } from './agent-payload';
import { AgentHookEvent, AgentEventKind, FileOperation } from '../core/agent-event';
import { NormalizedBashInput, NormalizedEdit, NormalizedToolInput, ToolKind } from '../core/types';

/**
 * The Claude Code tools that enter the file/edit rule pipeline. `Read` is deliberately NOT here — it
 * has its own fast path and only one guard may see it.
 */
const HANDLED_FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * Morphs a Claude Code PreToolUse payload into the one normalized `AgentHookEvent`.
 *
 * This is the SAME `normalizeToolKind` / `normalizeToolInput` logic that used to live inline in
 * hook-core.ts, moved out unchanged so hook-core is written once for every harness. Claude Code is the
 * harness every developer uses today, so nothing about the mapping is allowed to move: `Write` still
 * becomes one edit of `content` against '', `Edit` one edit of `old_string`→`new_string`, `MultiEdit`
 * one per entry, and a file tool with no `file_path` still ends up allowed (kind `Ignored`).
 */
export class ClaudeCodeAdapter {
    /**
     * What is known from the ENVELOPE ALONE, touching nothing but `tool_name` and the identity fields.
     *
     * Not a second spelling of `toEvent` — a different question, asked at a moment when the answer to
     * the other one may not exist. `toEvent` reads `tool_input`, and a payload whose `tool_input` is
     * missing makes it throw; the crash then still has to be DENIED, and the deny still has to know
     * whether it is decorating a Bash block (which needs the red `systemMessage`) or a file block
     * (which does not). This is the shape that answers that, and it cannot fail.
     */
    envelope(payload: AgentPayload): AgentHookEvent {
        return new AgentHookEvent(
            'claude-code', this.kindOf(payload.tool_name), payload.tool_name,
            payload.cwd ?? '', payload.session_id ?? '', payload.agent_id ?? '', payload.agent_type ?? '',
            [], null, [],
        );
    }

    toEvent(payload: AgentPayload, cwd: string): AgentHookEvent {
        const kind = this.kindOf(payload.tool_name);
        const toolInput = payload.tool_input;
        const bash = kind === 'Bash' ? new NormalizedBashInput(toolInput.command ?? '') : null;
        const reads = kind === 'Read' ? [toolInput.file_path ?? ''] : [];
        const files = kind === 'File' ? this.fileOperations(payload.tool_name as ToolKind, toolInput) : [];
        // A file tool that named no file has nothing to judge; fall back to Ignored so the hook allows
        // it, exactly as the old `if (!input) emitAllow()` did.
        const effective: AgentEventKind = kind === 'File' && files.length === 0 ? 'Ignored' : kind;
        return new AgentHookEvent(
            'claude-code', effective, payload.tool_name,
            cwd, payload.session_id ?? '', payload.agent_id ?? '', payload.agent_type ?? '',
            files, bash, reads,
        );
    }

    private kindOf(toolName: string): AgentEventKind {
        if (toolName === 'Bash') return 'Bash';
        if (toolName === 'Read') return 'Read';
        if (HANDLED_FILE_TOOLS.has(toolName)) return 'File';
        return 'Ignored';
    }

    private fileOperations(toolKind: ToolKind, toolInput: AgentToolInput): readonly FileOperation[] {
        const filePath = toolInput.file_path;
        if (!filePath) return [];
        if (toolKind === 'Write') {
            return [new FileOperation(toolKind, new NormalizedToolInput(filePath, [new NormalizedEdit('', toolInput.content || '')]))];
        }
        if (toolKind === 'Edit') {
            return [new FileOperation(toolKind, new NormalizedToolInput(filePath, [new NormalizedEdit(toolInput.old_string || '', toolInput.new_string || '')]))];
        }
        const raw = Array.isArray(toolInput.edits) ? toolInput.edits : [];
        const edits = raw.map((e: AgentEditEntry): NormalizedEdit => new NormalizedEdit(e.old_string || '', e.new_string || ''));
        return [new FileOperation(toolKind, new NormalizedToolInput(filePath, edits))];
    }
}
