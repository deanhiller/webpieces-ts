import { InformAiError } from '../core/types';
import { toError } from '../core/to-error';

/**
 * The RAW PreToolUse wire envelope, as it arrives on stdin.
 *
 * ONE shape for both harnesses, because that is what was measured: Codex uses the SAME key names as
 * Claude Code (`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`, `transcript_path`,
 * `agent_id`, `agent_type`) and merely ADDS `model`, `turn_id` and `tool_use_id`. A second payload
 * type for the second harness would be two spellings of one thing.
 *
 * Interfaces, not classes, and deliberately so: nothing in this codebase ever CONSTRUCTS one of these.
 * They describe bytes somebody else wrote, which `JSON.parse` hands back as a plain object — the same
 * reason the shape this replaces was an interface.
 */
export interface AgentPayload {
    tool_name: string;
    tool_input: AgentToolInput;
    /** The session's current working directory. Used to scope guards to the tree the agent is in. */
    cwd?: string;
    session_id?: string;
    /** Empty/absent ⇒ the coordinator, populated ⇒ a subagent. MEASURED identical in both harnesses. */
    agent_id?: string;
    agent_type?: string;
    /** Codex-only, and REQUIRED there. The one discriminator — see ./detect-ai.ts. */
    turn_id?: string;
}

export interface AgentToolInput {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    edits?: AgentEditEntry[];
    command?: string;
}

export interface AgentEditEntry {
    old_string?: string;
    new_string?: string;
}

export class AgentPayloadParser {
    /** Returns null for empty stdin (nothing to judge); throws InformAiError on unparseable bytes. */
    parse(raw: string): AgentPayload | null {
        if (!raw || raw.trim() === '') return null;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return JSON.parse(raw) as AgentPayload;
        } catch (err: unknown) {
            const error = toError(err);
            throw new InformAiError(`Malformed hook input from Claude Code stdin: ${error.message}`, { cause: error });
        }
    }
}
