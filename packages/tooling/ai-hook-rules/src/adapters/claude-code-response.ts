// The single place that knows Claude Code's PreToolUse decision protocol, so every deny in the
// Claude Code adapter is emitted identically — and identically to the checked-in shim
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

// ANSI escape (0x1b) built at runtime so no raw ESC byte sits in source. ANSI red is a *bonus* — the
// 🛑 prefix + reason stay meaningful if a future/CI renderer strips the color. One place = one escape.
const ESC = String.fromCharCode(0x1b);
function redSystemMessage(reason: string): string {
    return `${ESC}[31;1m🛑 ${reason}${ESC}[0m`;
}

export function denyJson(reason: string, toolName: string): string {
    const hookSpecificOutput = {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
    };
    // Bash only: permissionDecisionReason is NOT user-visible, so add the red systemMessage.
    if (toolName === 'Bash') {
        return JSON.stringify({ systemMessage: redSystemMessage(reason), hookSpecificOutput });
    }
    // Write/Edit/MultiEdit (and anything else): reason renders red natively; no systemMessage.
    return JSON.stringify({ hookSpecificOutput });
}

// Block the tool call and surface `reason` to both the user (terminal UI) and the model. `toolName`
// selects whether the red `systemMessage` is added (Bash) or omitted (file tools) — see denyJson.
// NOTE: emitDeny/emitAllow are the hook's designated terminal boundary — the exit code IS the
// Claude Code PreToolUse protocol (exit 0 + JSON = the contract). When the
// @webpieces/no-process-exit-outside-main rule is activated repo-wide (after the tooling release
// carrying it), add its eslint-disable-next-line above each process.exit below.
export function emitDeny(reason: string, toolName: string): never {
    process.stdout.write(denyJson(reason, toolName) + '\n');
    process.exit(0);
}

// Allow the tool call. No JSON needed — a silent exit 0 is "allow" in the PreToolUse protocol.
export function emitAllow(): never {
    process.exit(0);
}
