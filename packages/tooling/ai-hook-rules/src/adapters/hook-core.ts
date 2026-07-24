import * as path from 'path';

import { run, runBash, runRead } from '../core/runner';
import { logRejection } from '../core/rejection-log';
import { logGuardDecision, GuardDecision, branchForLog, logGuardInvocation } from '../core/decision-log';
import { triggerMainSyncRefresh } from '../core/main-sync-refresh';
import { CONFIG_FILENAME } from '../core/load-config';
import { RepoRootFinder } from '@webpieces/rules-config';
import { NormalizedToolInput, NormalizedEdit, ToolKind, InformAiError, RuleFailError, HookMode, BlockedResult } from '../core/types';
import { toError } from '../core/to-error';
import { emitDeny, emitAllow } from './claude-code-response';
import { committedShimStale, isShimCureCommand, shimStaleDenyReason, installedShimRulesVersion } from '../bin/shim';

// Which category of rules this hook invocation runs. The hook is split into two independently
// installable PreToolUse hooks; each runs ONE category (the runner filters by it), and both can
// receive file AND bash payloads:
//  - 'rules'  → code-style rules (file/edit scope). Bash payloads pass through (no code rules apply).
//  - 'guards' → hookGuards section: bash git/PR guards on Bash AND file guards (feature-branch-guard)
//               on Write/Edit, PLUS a log-and-allow audit of Read. Matcher is Write|Edit|MultiEdit|Bash|Read.
//  - 'all'    → both categories, used by the openclaw plugin adapter (a single before_tool_call hook).
export type { HookMode };

const HANDLED_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// Read-only tools carry NO guard or code rule, but the guards hook owns the per-invocation audit log
// (guard-invocations.log). When the guards matcher includes these (see setup.ts GUARDS_HOOK), a
// log-and-allow fast path records every file the AI opens — so a human can later inspect whether it
// read a project's design.json BEFORE editing the project. Never blocked. Scoped to Read for now;
// widen (Grep/Glob/NotebookRead) later if desired.
const READ_ONLY_TOOLS = new Set(['Read']);

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
    // Persist the block + WHY. File-tool denies go to hook-rejection.log via logRejection, but a Bash
    // deny had no audit trail — record it in guard-sync-decisions.log so "blocked and why" is complete
    // for Bash too. `.webpieces` lives at the repo root, resolved from cwd. Best-effort; never blocks.
    const root = new RepoRootFinder().resolveRepoRoot(cwd);
    logGuardDecision(root, new GuardDecision('bash-guard', 'Bash', command ?? '', branchForLog(root), 'BLOCK', result.report));
    // Bash deny → pass 'Bash' so denyJson adds the ANSI-red systemMessage (the only field a Bash deny
    // shows the human; permissionDecisionReason is invisible on Bash). See claude-code-response.ts.
    emitDeny(result.report, 'Bash');
}

/**
 * The read-scoped guard pass. Returns normally to ALLOW; only calls emitDeny when the guard fires.
 *
 * Wrapped in its own catch that swallows into an allow. Every other path in this hook fails CLOSED,
 * and that is right for edits and shell commands — but a crash here would block the agent from
 * READING, which includes reading webpieces.config.json to turn the offending guard off. So this one
 * path deliberately inverts the policy: a broken read-guard degrades to a no-op, never to a wedge.
 */
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function handleRead(filePath: string, cwd: string, mode: HookMode): void {
    if (filePath === '') return;
    let result: BlockedResult | null = null;
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        result = runRead(filePath, cwd, mode);
    } catch (err: unknown) {
        const error = toError(err);
        void error;
        return; // fail OPEN — see the doc comment
    }
    if (!result) return;
    logRejection('Read', new NormalizedToolInput(filePath, []), result, cwd);
    emitDeny(result.report, 'Read');
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
            // `.webpieces/` (the decision log + sync cache these two calls write) lives at the repo
            // root, not the AI's cwd — resolve it so a config edit from a subdir doesn't create a
            // stray `<subdir>/.webpieces` tree.
            const root = new RepoRootFinder().resolveRepoRoot(cwd);
            logGuardDecision(
                root,
                new GuardDecision('feature-branch-guard', toolKind, input.filePath, branchForLog(root), 'ALLOW', 'config-bypass (feature-branch-guard skipped)'),
            );
            // The guard's own refresh trigger lives inside its check(), which we skip here — so warm
            // the cache directly, otherwise a session that only edits webpieces.config.json never
            // refreshes the sync status. Fire-and-forget; never blocks the edit.
            triggerMainSyncRefresh(root);
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

// Committed-shim self-guard, moved here from the rendered shim (2026-07-24). The committed
// .claude/webpieces/ai-hook.sh is webpieces-MANAGED and generated from renderShim(); if it no longer
// matches, it was reverted / hand-edited / predates this binary, so its OWN fail-closed logic can't be
// trusted. We are the CURRENT binary from node_modules — the trustworthy party — so WE decide here
// instead of the (possibly stale) shim. It used to `cmp` itself inside the shim: a double-edged trap,
// since the check lived in the very file it guarded and a fix could only ship by regenerating that
// file. Now: fail closed on EVERY tool (Reads included — nothing is safe until it matches again),
// allowing ONLY the three cures (isShimCureCommand) so the AI can re-arm it — NOT a deadlock. We deny +
// tell the AI; we do NOT silently rewrite the file under it. 'rules' hook skips it (guards owns the
// shim). `command` is '' for non-Bash tools, so only a Bash cure can match. Returns normally (nothing
// to do) or exits via emitAllow/emitDeny.
// webpieces-disable no-function-outside-class -- sibling of handleBash()/handleFileTool() in this module; the adapter is module-scope functions by design
function enforceCommittedShim(toolName: string, command: string, cwd: string, mode: HookMode): void {
    if (mode === 'rules' || !committedShimStale(cwd)) return;
    if (isShimCureCommand(command)) emitAllow();
    emitDeny(shimStaleDenyReason(installedShimRulesVersion()), toolName);
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

        // Committed-shim self-guard (moved here from the shim, 2026-07-24). Runs BEFORE read handling so
        // a stale shim blocks EVERY tool, Reads included — see enforceCommittedShim for the full why.
        enforceCommittedShim(payload.tool_name, payload.tool_input.command ?? '', cwd, mode);

        // Read-only tools (Read): audit-log, warm the main-sync cache, then run the ONE read-scoped
        // guard (read-stale-guard) and allow. Runs BEFORE the general rule engine — no code-style rule
        // ever sees a Read, and the only way this path can deny is a stale `main`.
        // The audit trail still records every file the AI opened (see setup.ts).
        if (READ_ONLY_TOOLS.has(payload.tool_name)) {
            const readPath = payload.tool_input.file_path ?? '';
            if (mode !== 'rules') {
                logGuardInvocation(cwd, payload.tool_name, readPath);
                // Reads vastly outnumber edits, so refreshing here is what actually keeps the shared
                // main-sync cache warm for feature-branch-guard. Detached; never slows the read.
                triggerMainSyncRefresh(cwd);
            }
            handleRead(readPath, cwd, mode);
            emitAllow();
        }

        // Per-invocation guard log (guard-invocations.log): tool + command/file + live branch +
        // main-sync-status snapshot, on EVERY guards call, for later cleanup automation. Best-effort;
        // never blocks the call. (The committed shim is no longer silently healed here — a mismatch is
        // reported by the self-guard above, not rewritten out from under the AI.)
        if (mode !== 'rules') {
            const target = payload.tool_name === 'Bash' ? (payload.tool_input.command ?? '') : (payload.tool_input.file_path ?? '');
            logGuardInvocation(cwd, payload.tool_name, target);
        }

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
