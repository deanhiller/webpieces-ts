import { AgentPayload } from './agent-payload';
import { AgentHookEvent } from '../core/agent-event';
import { detectAiType } from './detect-ai';
import { ClaudeCodeAdapter } from './claude-code-adapter';
import { CodexAdapter } from './codex-adapter';

/**
 * The ONE place a payload is routed to its harness's adapter. Every other module takes an
 * `AgentHookEvent` and never asks which agent produced it — except the two codex-only surfaces
 * (read parity, the shared-tree subagent guard), which check `aiType` explicitly and say so.
 */
export class AgentAdapters {
    private readonly claude = new ClaudeCodeAdapter();
    private readonly codex = new CodexAdapter();

    envelope(payload: AgentPayload): AgentHookEvent {
        return detectAiType(payload) === 'codex' ? this.codex.envelope(payload) : this.claude.envelope(payload);
    }

    toEvent(payload: AgentPayload, cwd: string): AgentHookEvent {
        return detectAiType(payload) === 'codex' ? this.codex.toEvent(payload, cwd) : this.claude.toEvent(payload, cwd);
    }
}
