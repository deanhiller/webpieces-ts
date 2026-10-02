import { AgentHookEvent } from './protocol';

const ESC = String.fromCharCode(0x1b);

// webpieces-disable no-function-outside-class -- private wire-format helper at the protocol boundary.
function redSystemMessage(reason: string): string {
    const nl = reason.indexOf('\n');
    if (nl < 0) return `${ESC}[31;1m🛑 ${reason}${ESC}[0m`;
    return `${ESC}[31;1m🛑 ${reason.slice(0, nl)}${ESC}[0m${reason.slice(nl)}`;
}

// webpieces-disable no-function-outside-class -- the shared PreToolUse wire format.
export function denyJson(event: AgentHookEvent | null, reason: string): string {
    const safe = reason.trim() === '' ? '[ai-hooks] blocked, but the guard produced no reason — failing closed.' : reason;
    const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: safe };
    if (event !== null && event.kind === 'Bash') {
        return JSON.stringify({ systemMessage: redSystemMessage(safe), hookSpecificOutput });
    }
    return JSON.stringify({ hookSpecificOutput });
}
