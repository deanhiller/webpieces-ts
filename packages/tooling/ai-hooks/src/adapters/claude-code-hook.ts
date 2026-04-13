import { run } from '../core/runner';
import { NormalizedToolInput, NormalizedEdit, ToolKind } from '../core/types';
import { toError } from '../core/to-error';

const HANDLED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

interface ClaudeCodePayload {
    tool_name: string;
    tool_input: ClaudeCodeToolInput;
}

interface ClaudeCodeToolInput {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    edits?: ClaudeCodeEditEntry[];
}

interface ClaudeCodeEditEntry {
    old_string?: string;
    new_string?: string;
}

function readStdin(): Promise<string> {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
        if (process.stdin.isTTY) resolve('');
    });
}

function safeParse(raw: string): ClaudeCodePayload | null {
    if (!raw || raw.trim() === '') return null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return JSON.parse(raw) as ClaudeCodePayload;
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return null;
    }
}

function normalizeToolKind(toolName: string): ToolKind | null {
    if (HANDLED_TOOLS.has(toolName)) return toolName as ToolKind;
    return null;
}

function normalizeToolInput(toolKind: ToolKind, toolInput: ClaudeCodeToolInput): NormalizedToolInput | null {
    const filePath = toolInput.file_path;
    if (!filePath) return null;

    if (toolKind === 'Write') {
        return new NormalizedToolInput(filePath, [
            new NormalizedEdit('', toolInput.content || ''),
        ]);
    }
    if (toolKind === 'Edit') {
        return new NormalizedToolInput(filePath, [
            new NormalizedEdit(toolInput.old_string || '', toolInput.new_string || ''),
        ]);
    }
    if (toolKind === 'MultiEdit') {
        const raw = Array.isArray(toolInput.edits) ? toolInput.edits : [];
        const edits = raw.map((e) => new NormalizedEdit(e.old_string || '', e.new_string || ''));
        return new NormalizedToolInput(filePath, edits);
    }
    return null;
}

export async function main(): Promise<void> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = await readStdin();
        const payload = safeParse(raw);
        if (!payload) { process.exit(0); return; }

        const toolKind = normalizeToolKind(payload.tool_name);
        if (!toolKind) { process.exit(0); return; }

        const input = normalizeToolInput(toolKind, payload.tool_input);
        if (!input) { process.exit(0); return; }

        const result = run(toolKind, input, process.cwd());
        if (!result) { process.exit(0); return; }

        process.stderr.write(result.report);
        process.exit(2);
    } catch (err: unknown) {
        const error = toError(err);
        process.stderr.write(`[ai-hooks] claude-code adapter crashed (failing open): ${error.message}\n`);
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}
