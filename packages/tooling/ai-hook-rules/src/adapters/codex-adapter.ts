import { RepoRootFinder } from '@webpieces/rules-config';

import { AgentPayload } from './agent-payload';
import { AgentHookEvent, AgentEventKind } from '../core/agent-event';
import { NormalizedBashInput } from '../core/types';
import { ApplyPatchParser } from '../core/apply-patch-parse';
import { ShellReadParity } from '../core/shell-read-parity';

/** Codex's shell tool. MEASURED: it reuses Claude's name — it is `Bash`, NOT `shell`. */
const CODEX_BASH = 'Bash';
/** Codex's ONLY file-editing tool. One envelope, many files, mixed operations. */
const CODEX_APPLY_PATCH = 'apply_patch';

/**
 * Morphs a Codex PreToolUse payload into the one normalized `AgentHookEvent`.
 *
 * Codex exposes exactly two tools this hook has anything to say about. Everything else measured in a
 * live session — `webrun`, `collaborationspawn_agent`, `collaborationwait_agent`, `view_image`,
 * `update_plan` — and every tool not yet seen maps to `Ignored` and is allowed immediately. That
 * default is chosen on purpose: an unknown tool is one we cannot judge, and inventing a mapping for it
 * would apply file rules to bytes that are not a file edit.
 */
export class CodexAdapter {
    private readonly patchParser = new ApplyPatchParser();
    private readonly readParity = new ShellReadParity();

    /** See ClaudeCodeAdapter.envelope — the pre-normalization shape the crash deny needs. */
    envelope(payload: AgentPayload): AgentHookEvent {
        return new AgentHookEvent(
            'codex', this.kindOf(payload.tool_name), payload.tool_name,
            payload.cwd ?? '', payload.session_id ?? '', payload.agent_id ?? '', payload.agent_type ?? '',
            [], null, [],
        );
    }

    toEvent(payload: AgentPayload, cwd: string): AgentHookEvent {
        const kind = this.kindOf(payload.tool_name);
        const command = payload.tool_input.command ?? '';
        const bash = kind === 'Bash' ? new NormalizedBashInput(command) : null;
        // Read parity: Codex has no Read tool, so a read arrives as `Bash` running a pager. Synthesized
        // reads run the read guard IN ADDITION to the bash guards — see ../core/shell-read-parity.ts.
        const reads = kind === 'Bash' ? this.readParity.readTargets(command, cwd, new RepoRootFinder().resolveRepoRoot(cwd)) : [];
        const files = kind === 'File' ? this.patchParser.parse(command, cwd) : [];
        return new AgentHookEvent(
            'codex', kind, payload.tool_name,
            cwd, payload.session_id ?? '', payload.agent_id ?? '', payload.agent_type ?? '',
            files, bash, reads,
        );
    }

    private kindOf(toolName: string): AgentEventKind {
        if (toolName === CODEX_BASH) return 'Bash';
        if (toolName === CODEX_APPLY_PATCH) return 'File';
        return 'Ignored';
    }
}
