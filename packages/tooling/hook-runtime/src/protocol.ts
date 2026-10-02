/** Coding harness that produced an agent-hook call. */
export type AiType = 'claude-code' | 'codex';
export const AI_TYPES: readonly AiType[] = ['claude-code', 'codex'];
export const AI_TYPE_UNKNOWN = 'unknown';
export type HookMode = 'rules' | 'guards' | 'all';
export type ToolKind = 'Write' | 'Edit' | 'MultiEdit' | 'Read' | 'Delete';
export type AgentEventKind = 'File' | 'Bash' | 'Read' | 'Ignored';

export class NormalizedEdit {
    readonly oldString: string;
    readonly newString: string;
    constructor(oldString: string, newString: string) { this.oldString = oldString; this.newString = newString; }
}

export class NormalizedToolInput {
    readonly filePath: string;
    readonly edits: readonly NormalizedEdit[];
    constructor(filePath: string, edits: readonly NormalizedEdit[]) { this.filePath = filePath; this.edits = edits; }
}

export class NormalizedBashInput {
    readonly command: string;
    constructor(command: string) { this.command = command; }
}

export class FileOperation {
    readonly toolKind: ToolKind;
    readonly input: NormalizedToolInput;
    constructor(toolKind: ToolKind, input: NormalizedToolInput) { this.toolKind = toolKind; this.input = input; }
}

/** One normalized hook event, independent of the source harness and rule product. */
export class AgentHookEvent {
    readonly aiType: AiType;
    readonly kind: AgentEventKind;
    readonly rawToolName: string;
    readonly cwd: string;
    readonly sessionId: string;
    readonly agentId: string;
    readonly agentType: string;
    readonly files: readonly FileOperation[];
    readonly bash: NormalizedBashInput | null;
    readonly reads: readonly string[];

    constructor(
        aiType: AiType, kind: AgentEventKind, rawToolName: string, cwd: string, sessionId: string,
        agentId: string, agentType: string, files: readonly FileOperation[],
        bash: NormalizedBashInput | null, reads: readonly string[],
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
