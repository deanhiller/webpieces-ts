// The single place that knows the PreToolUse decision protocol, so every deny is emitted identically
// — and identically to the checked-in shim
// (.claude/webpieces/ai-hook.sh, rendered by renderShim() in ../bin/shim.ts), which emits the same JSON.
//
// A block is signalled by `permissionDecision: "deny"` JSON on STDOUT with exit 0 — NOT exit 2.
// Claude Code only parses the JSON on exit 0; exit 2 would ignore stdout and the reason would not
// surface in the terminal UI. "deny" still blocks the tool, so this remains fail-closed: it is not the
// silent-allow a bare exit 0 with no JSON would be.
//
// WHY the tool-conditional `systemMessage` (verified by live tests against Claude Code v2.1.x — the
// docs are wrong here; do NOT re-derive from them):
//
//   | deny field                        | Bash tool                         | Write/Edit/MultiEdit tool     |
//   |-----------------------------------|-----------------------------------|-------------------------------|
//   | permissionDecisionReason (plain)  | model sees it; USER SEES NOTHING  | model + RED "Error:" block ok |
//   | systemMessage                     | ONLY user-visible field; grey     | grey extra line (redundant)   |
//   | systemMessage wrapped in ANSI red | RED + visible to the user (fix)   | redundant 2nd red line        |
//
// So: on a **Bash** deny we ALSO emit a top-level `systemMessage` wrapped in ANSI red (ESC[31;1m …
// ESC[0m) — it is the only field a Bash deny shows the human, and it honors ANSI. On
// Write/Edit/MultiEdit we add NO `systemMessage` (the reason already renders red natively — a second
// line is just noise). `permissionDecisionReason` is always plain text (never ANSI): it's what the
// model reads and what Write/Edit renders red. JSON.stringify serializes the ESC char as the valid
// \u escape, so the payload stays valid JSON — we build the ESC via String.fromCharCode(0x1b) so no
// raw ESC (0x1b) byte ever lives in this source file. Do NOT use exit 2 (stdout JSON ignored;
// stderr invisible to the user on Bash).
// Refs: Claude Code GitHub issues #31592, #40380, #17356 (asymmetry "closed / not planned").

import { invocationLog } from '../core/decision-log';
import { L0_FAULT_NONE } from '../core/l0-fault-codes';
import { AgentHookEvent } from '../core/agent-event';

// ANSI escape (0x1b) built at runtime so no raw ESC byte sits in source. ANSI red is a *bonus* — the
// 🛑 prefix + reason stay meaningful if a future/CI renderer strips the color. One place = one escape.
const ESC = String.fromCharCode(0x1b);

/**
 * ONLY THE HEADLINE IS RED. The body is left plain, and that is a legibility decision, not an oversight.
 *
 * Every deny that reaches here is MULTI-LINE — formatReport()'s `[rule] (N violations)` / `→ why` /
 * `Fix Option N:` skeleton for L1 and L2, and now the same skeleton for L0. A whole page rendered in
 * bold red is harder to read than the paragraph it replaced: the indentation that carries the structure
 * stops registering when every line shouts. Red the first line so the block is unmissable in a scroll of
 * terminal output, then let the structure do the rest of the work.
 *
 * The reset (`[0m`) still closes the sequence on the same line it opened, so nothing leaks into the
 * body or into whatever the terminal prints next.
 */
function redSystemMessage(reason: string): string {
    const nl = reason.indexOf('\n');
    if (nl < 0) return `${ESC}[31;1m🛑 ${reason}${ESC}[0m`;
    return `${ESC}[31;1m🛑 ${reason.slice(0, nl)}${ESC}[0m${reason.slice(nl)}`;
}

// Takes the EVENT rather than a tool-name string, because the one thing this decision needs is the
// event's routing kind, and the harnesses spell their tool names differently (`Bash` vs `apply_patch`)
// while agreeing on the kind. The emitted bytes are identical for both harnesses — Codex accepts the
// same `permissionDecision: "deny"` + `permissionDecisionReason` + `systemMessage` fields, and rejects
// nothing we emit. It does hard-reject an EMPTY `permissionDecisionReason` where Claude tolerates one,
// which is why emitDeny below refuses to send one.
export function denyJson(event: AgentHookEvent | null, reason: string): string {
    // NEVER an empty reason, and the check lives HERE because this function owns the wire shape. Codex
    // hard-rejects a deny whose permissionDecisionReason is empty (Claude tolerates it and shows the
    // human nothing), so an empty one is not a cosmetic defect — it is a block that silently fails to
    // block. Every call site passes prose; this is the backstop that keeps a future one from turning a
    // deny into a protocol error.
    const safe = reason.trim() === '' ? '[ai-hooks] blocked, but the guard produced no reason — failing closed.' : reason;
    const hookSpecificOutput = {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: safe,
    };
    // Bash only: permissionDecisionReason is NOT user-visible, so add the red systemMessage.
    if (event !== null && event.kind === 'Bash') {
        return JSON.stringify({ systemMessage: redSystemMessage(safe), hookSpecificOutput });
    }
    // Write/Edit/MultiEdit (and anything else): reason renders red natively; no systemMessage.
    return JSON.stringify({ hookSpecificOutput });
}

// Block the tool call and surface `reason` to both the user (terminal UI) and the model. The event's
// kind selects whether the red `systemMessage` is added (Bash) or omitted (file tools) — see denyJson.
// emitDeny/emitAllow are the hook's designated terminal boundary — the exit code IS the Claude Code
// PreToolUse protocol (exit 0 + JSON = the contract), so the process.exit stays and is allowlisted.
//
// Being the ONE boundary every path exits through is also why the per-invocation audit line is
// flushed HERE: the `calls/` stream carries the outcome of its own call, and the outcome is not
// known until this point. `rule` names what blocked (or '-'), for the line's `rule=` field.
//
// `fault` is the L0 fault code when the block IS an L0 fault (S/C/Y — the three decided here in JS,
// where the sh shim's own `fault=` stamp can never reach), else '-'. Stamping it at this ONE boundary is
// what makes `grep 'fault=S'` span the whole audit trail rather than only its sh half.
// webpieces-disable no-function-outside-class -- the Claude Code PreToolUse protocol boundary; module-scope beside denyJson/emitAllow by design, and it must stay callable from a tree too broken to build a DI container.
export function emitDeny(event: AgentHookEvent | null, reason: string, rule: string = '-', fault: string = L0_FAULT_NONE): never {
    // BLOCK_AI_CURE: every deny that reaches this boundary prints a cure the agent can act on — the
    // L0 faults name a command on the allowlist, and the L1/L2 guards print theirs. A deny needing a
    // HUMAN would have to say so at its own site; none does today, and inventing one here would be
    // guessing at the boundary rather than at the decision.
    invocationLog.finish('BLOCK_AI_CURE', rule, fault);
    process.stdout.write(denyJson(event, reason) + '\n');
    // webpieces-disable no-process-exit-outside-main -- hook exit-code IS the Claude Code PreToolUse protocol (exit 0 + JSON = the contract); designated terminal boundary.
    process.exit(0);
}

// Allow the tool call. No JSON needed — a silent exit 0 is "allow" in the PreToolUse protocol.
export function emitAllow(): never {
    invocationLog.finish('ALLOW', '-');
    // webpieces-disable no-process-exit-outside-main -- hook exit-code IS the Claude Code PreToolUse protocol (silent exit 0 = "allow"); designated terminal boundary.
    process.exit(0);
}
