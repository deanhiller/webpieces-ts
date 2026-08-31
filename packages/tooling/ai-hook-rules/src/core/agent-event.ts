import { ToolKind, NormalizedToolInput, NormalizedBashInput } from './types';

/**
 * WHICH coding agent produced this hook call. The ONE discriminator that decides it lives in
 * ../adapters/detect-ai.ts (`turn_id` present ⇒ codex) and nowhere else.
 *
 * Every codex-only surface — the apply_patch parser, shell read-parity, the shared-tree subagent
 * guard — is gated on this field, so a Claude Code call can never reach any of them. That is not a
 * nicety: Claude Code is the harness every developer uses today and its behaviour must not move.
 */
export type AiType = 'claude-code' | 'codex';

/**
 * The `AiType` union AS DATA, so the audit-log vocabulary is rendered from the type rather than retyped
 * beside it. Adding a harness means adding it here and getting the log field's documented value set for
 * free — the same reason `SHIM_LOG_FAULTS` is built from `L0_SH_FAULT_CODES` rather than retyped.
 */
export const AI_TYPES: readonly AiType[] = ['claude-code', 'codex'];

/**
 * What a log row shows when NOTHING established the harness: a row written by a release older than the
 * `ai=` field, or a writer reached before any payload was parsed (the openclaw plugin, a library
 * consumer, a spec).
 *
 * It is a REAL VALUE, not a compatibility shim and not an absence. `ai=unknown` is greppable and
 * countable; an omitted field is neither, and "no `ai=`" would be indistinguishable from "this reader is
 * looking at the wrong column".
 */
export const AI_TYPE_UNKNOWN = 'unknown';

/**
 * How the hook ROUTES this call. It is deliberately NOT `ToolKind`.
 *
 * The plan sketched the field as `ToolKind | 'Bash' | 'Ignored'`, and that shape cannot express the
 * measured Codex reality: ONE `apply_patch` envelope carries MANY files with MIXED operations (an
 * Add, an Update and a Delete in a single call). A single event-level `ToolKind` would have to pick
 * one of them and lie about the rest. So the per-file kind moved down onto `FileOperation`, where
 * there is one per file, and the event keeps only the routing question:
 *
 *   - 'File'    → run the file/edit pipeline over `files` (one entry for Claude, N for Codex).
 *   - 'Bash'    → run the bash guards over `bash`. `reads` may ALSO be populated on a Codex call
 *                 whose command is read-shaped (see ../core/shell-read-parity.ts).
 *   - 'Read'    → the read fast path over `reads`.
 *   - 'Ignored' → nothing to judge; allow immediately.
 */
export type AgentEventKind = 'File' | 'Bash' | 'Read' | 'Ignored';

/**
 * ONE file touched by ONE operation, with the kind that operation is.
 *
 * `toolKind` is per-FILE precisely because `apply_patch` mixes operations inside one call; see
 * AgentEventKind's header for why this is not carried on the event.
 */
export class FileOperation {
    readonly toolKind: ToolKind;
    readonly input: NormalizedToolInput;

    constructor(toolKind: ToolKind, input: NormalizedToolInput) {
        this.toolKind = toolKind;
        this.input = input;
    }
}

/**
 * The ONE normalized shape every harness's PreToolUse payload is morphed into, so the hook body,
 * the guards and the audit log are written once rather than once per agent.
 *
 * A data class per CLAUDE.md rule 1: fields only, explicit constructor, no business logic. The
 * morphing lives in the adapters (../adapters/claude-code-adapter.ts, ../adapters/codex-adapter.ts).
 */
export class AgentHookEvent {
    readonly aiType: AiType;
    readonly kind: AgentEventKind;
    /** The harness's own tool name — 'Edit', 'apply_patch', 'Bash'. Carried for logs, never switched on. */
    readonly rawToolName: string;
    readonly cwd: string;
    readonly sessionId: string;
    /**
     * MEASURED, and identical in both harnesses: empty ⇒ the coordinator, populated ⇒ a subagent.
     * Used to NAME a log writer, and by the Codex shared-tree guard to know it is talking to a
     * subagent. Never to decide WHICH TREE a call acts on — that is measured from the path.
     */
    readonly agentId: string;
    readonly agentType: string;
    /** Claude: exactly 0 or 1. Codex `apply_patch`: N, with mixed kinds. */
    readonly files: readonly FileOperation[];
    readonly bash: NormalizedBashInput | null;
    /** Read targets. Claude: the `Read` tool's file. Codex: read-parity synthesis, else empty. */
    readonly reads: readonly string[];

    constructor(
        aiType: AiType,
        kind: AgentEventKind,
        rawToolName: string,
        cwd: string,
        sessionId: string,
        agentId: string,
        agentType: string,
        files: readonly FileOperation[],
        bash: NormalizedBashInput | null,
        reads: readonly string[],
    ) {
        this.aiType = aiType;
        this.kind = kind;
        this.rawToolName = rawToolName;
        this.cwd = cwd;
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.agentType = agentType;
        this.files = files;
        this.bash = bash;
        this.reads = reads;
    }
}
