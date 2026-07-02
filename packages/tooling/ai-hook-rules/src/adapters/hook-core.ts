import * as path from 'path';

import { run, runBash } from '../core/runner';
import { logRejection } from '../core/rejection-log';
import { logGuardDecision, GuardDecision, branchForLog } from '../core/decision-log';
import { triggerMainSyncRefresh } from '../core/main-sync-refresh';
import { CONFIG_FILENAME } from '../core/load-config';
import { NormalizedToolInput, NormalizedEdit, ToolKind, InformAiError, RuleFailError, HookMode } from '../core/types';
import { toError } from '../core/to-error';
import { emitDeny, emitAllow } from './claude-code-response';
import { healShim } from '../bin/shim';

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
    // Claude Code sends the session's current working directory (follows a persisted `cd`). Used to
    // scope guards to the git repo the AI is actually in — see runner git-repo-boundary governance.
    cwd?: string;
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
    if (!command || command.trim() === '') { emitAllow(); }
    const result = runBash(command, cwd, mode);
    if (!result) { emitAllow(); }
    // Bash deny → pass 'Bash' so denyJson adds the ANSI-red systemMessage (the only field a Bash deny
    // shows the human; permissionDecisionReason is invisible on Bash). See claude-code-response.ts.
    emitDeny(result.report, 'Bash');
}

function handleFileTool(payload: ClaudeCodePayload, cwd: string, mode: HookMode): void {
    const toolKind = normalizeToolKind(payload.tool_name);
    if (!toolKind) { emitAllow(); }

    const input = normalizeToolInput(toolKind, payload.tool_input);
    if (!input) { emitAllow(); }

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
        emitAllow();
    }

    const result = run(toolKind, input, cwd, mode);
    if (!result) { emitAllow(); }

    logRejection(toolKind, input, result, cwd);
    // File-tool deny → pass the Write/Edit/MultiEdit kind so denyJson omits systemMessage (the reason
    // already renders red natively for these tools). See claude-code-response.ts.
    emitDeny(result.report, toolKind);
}

/**
 * Shared entry point for all three Claude Code PreToolUse adapters. `mode` selects which tool kinds
 * to validate; payloads outside the mode's scope pass through (emitAllow). Blocks by emitting a
 * PreToolUse `permissionDecision:"deny"` JSON on stdout (exit 0) — see claude-code-response.ts. Fails
 * CLOSED on any unexpected crash (emits a deny) so a broken hook never silently lets an edit through,
 * and the reason now surfaces in the Claude Code UI instead of being hidden on a stderr+exit-2 block.
 */
export async function runMain(mode: HookMode): Promise<void> {
    // Captured from the payload as soon as it parses so the fail-closed catch below can tell denyJson
    // which tool it is denying — a crash on a Bash call still gets the visible red systemMessage, a
    // crash on a file tool does not. Empty (before parse / malformed input) → treated as non-Bash.
    let toolName = '';
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const raw = await readStdin();
        const payload = safeParse(raw);
        if (!payload) { emitAllow(); }
        toolName = payload.tool_name;

        // Prefer the payload cwd (the AI's actual working dir, follows a persisted `cd`) over
        // process.cwd(); they match today, but the payload is the authoritative signal and stays
        // correct if the hook is ever invoked from a fixed dir (e.g. via $CLAUDE_PROJECT_DIR).
        const cwd = payload.cwd ?? process.cwd();

        // Keep the committed shim (.claude/webpieces/ai-hook.sh) identical to renderShim() so its
        // fail-closed escape hatch + installer allowlist never go stale — no human hand-edits it.
        // Runs only when the guards binary is actually installed (i.e. now), is best-effort, and
        // never throws into the decision below. 'rules' hook skips it (guards owns the shim).
        if (mode !== 'rules') healShim(cwd);

        if (payload.tool_name === 'Bash') {
            // No code-style rule is bash-scoped, so the rules hook ignores Bash.
            if (mode === 'rules') { emitAllow(); }
            handleBash(payload, cwd, mode);
            return;
        }

        // File payloads run in 'rules' (code-style), 'guards' (file-scoped guards like
        // feature-branch-guard), and 'all'. The runner filters to the right category.
        handleFileTool(payload, cwd, mode);
    } catch (err: unknown) {
        const error = toError(err);
        // An escaped RuleFailError (a rule that threw past the runner's per-rule catch) or an
        // InformAiError (bad config/stdin) both carry an AI-readable message; anything else is an
        // unexpected bug. All three deny (fail closed) and surface their reason to the AI.
        if (error instanceof RuleFailError) {
            emitDeny(error.aiMessage, toolName);
        } else if (error instanceof InformAiError) {
            emitDeny(error.message, toolName);
        } else {
            emitDeny(`[ai-hooks] hook crashed unexpectedly — failing closed: ${error.message}`, toolName);
        }
    }
}
