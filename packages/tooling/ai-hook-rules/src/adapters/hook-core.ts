import * as path from 'path';

import { run, runBash } from '../core/runner';
import { logRejection } from '../core/rejection-log';
import { logGuardDecision, GuardDecision, branchForLog } from '../core/decision-log';
import { triggerMainSyncRefresh } from '../core/main-sync-refresh';
import { CONFIG_FILENAME } from '../core/load-config';
import { NormalizedToolInput, NormalizedEdit, ToolKind, InformAiError, HookMode } from '../core/types';
import { toError } from '../core/to-error';

// Which category of rules this hook invocation runs. The hook is split into two independently
// installable PreToolUse hooks; each runs ONE category (the runner filters by it), and both can
// receive file AND bash payloads:
//  - 'rules'  → code-style rules (file/edit scope). Bash payloads pass through (no code rules apply).
//  - 'guards' → hookGuards section: bash git/PR guards on Bash AND file guards (feature-branch-guard)
//               on Write/Edit. Matcher is Write|Edit|MultiEdit|Bash.
//  - 'all'    → both categories, for the combined back-compat `wp-ai-hook` bin.
export type { HookMode };

const HANDLED_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

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
    command?: string;
}

interface ClaudeCodeEditEntry {
    old_string?: string;
    new_string?: string;
}

function readStdin(): Promise<string> {
    return new Promise((resolve: (value: string) => void) => {
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
        throw new InformAiError(`Malformed hook input from Claude Code stdin: ${error.message}`, { cause: error });
    }
}

function normalizeToolKind(toolName: string): ToolKind | null {
    if (HANDLED_FILE_TOOLS.has(toolName)) return toolName as ToolKind;
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
        const edits = raw.map((e: ClaudeCodeEditEntry) => new NormalizedEdit(e.old_string || '', e.new_string || ''));
        return new NormalizedToolInput(filePath, edits);
    }
    return null;
}

function handleBash(payload: ClaudeCodePayload, cwd: string, mode: HookMode): void {
    const command = payload.tool_input.command;
    if (!command || command.trim() === '') { process.exit(0); return; }
    const result = runBash(command, cwd, mode);
    if (!result) { process.exit(0); return; }
    process.stderr.write(result.report);
    process.exit(2);
}

function handleFileTool(payload: ClaudeCodePayload, cwd: string, mode: HookMode): void {
    const toolKind = normalizeToolKind(payload.tool_name);
    if (!toolKind) { process.exit(0); return; }

    const input = normalizeToolInput(toolKind, payload.tool_input);
    if (!input) { process.exit(0); return; }

    // Always allow edits to webpieces.config.json — it's the fix target when the config is broken.
    // This exits BEFORE run(), so feature-branch-guard never sees a config edit; record that so the
    // audit trail explains why a config edit on a bad branch was not blocked (see decision-log.ts).
    if (path.basename(input.filePath) === CONFIG_FILENAME) {
        if (mode !== 'rules') {
            logGuardDecision(
                cwd,
                new GuardDecision('feature-branch-guard', toolKind, input.filePath, branchForLog(cwd), 'ALLOW', 'config-bypass (feature-branch-guard skipped)'),
            );
            // The guard's own refresh trigger lives inside its check(), which we skip here — so warm
            // the cache directly, otherwise a session that only edits webpieces.config.json never
            // refreshes the sync status. Fire-and-forget; never blocks the edit.
            triggerMainSyncRefresh(cwd);
        }
        process.exit(0);
        return;
    }

    const result = run(toolKind, input, cwd, mode);
    if (!result) { process.exit(0); return; }

    logRejection(toolKind, input, result, cwd);
    process.stderr.write(result.report);
    process.exit(2);
}

/**
 * Shared entry point for all three Claude Code PreToolUse adapters. `mode` selects which tool kinds
 * to validate; payloads outside the mode's scope pass through (exit 0). Fails CLOSED (exit 2) on any
 * unexpected crash so a broken hook never silently lets an edit through.
 */
export async function runMain(mode: HookMode): Promise<void> {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = await readStdin();
        const payload = safeParse(raw);
        if (!payload) { process.exit(0); return; }

        const cwd = process.cwd();

        if (payload.tool_name === 'Bash') {
            // No code-style rule is bash-scoped, so the rules hook ignores Bash.
            if (mode === 'rules') { process.exit(0); return; }
            handleBash(payload, cwd, mode);
            return;
        }

        // File payloads run in 'rules' (code-style), 'guards' (file-scoped guards like
        // feature-branch-guard), and 'all'. The runner filters to the right category.
        handleFileTool(payload, cwd, mode);
    } catch (err: unknown) {
        const error = toError(err);
        if (err instanceof InformAiError) {
            process.stderr.write(error.message + '\n');
        } else {
            process.stderr.write(`[ai-hooks] hook crashed unexpectedly — failing closed: ${error.message}\n`);
        }
        process.exit(2);
    }
}
