// The single place that knows Claude Code's PreToolUse decision protocol, so every deny in the
// Claude Code adapter is emitted identically — and identically to the checked-in shim
// (.claude/webpieces/ai-hook.sh, rendered by renderShim() in ../bin/setup.ts), which already emits
// this exact JSON.
//
// A block is signalled by `permissionDecision: "deny"` JSON on STDOUT with exit 0 — NOT exit 2.
// Claude Code only parses the JSON on exit 0; exit 2 would ignore stdout and the reason would not
// surface in the terminal UI (the original bug). "deny" still blocks the tool, so this remains
// fail-closed: it is not the silent-allow a bare exit 0 with no JSON would be.

export function denyJson(reason: string): string {
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    });
}

// Block the tool call and surface `reason` to both the user (terminal UI) and the model.
export function emitDeny(reason: string): never {
    process.stdout.write(denyJson(reason) + '\n');
    process.exit(0);
}

// Allow the tool call. No JSON needed — a silent exit 0 is "allow" in the PreToolUse protocol.
export function emitAllow(): never {
    process.exit(0);
}
