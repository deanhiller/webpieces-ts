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
import { AgentHookEvent, HookOutcome, HookTerminated, denyJson } from '@webpieces/hook-runtime';
export { denyJson } from '@webpieces/hook-runtime';

// THE DENY, AS A VALUE. `reason` is surfaced to both the user (terminal UI) and the model; the event's
// kind selects whether the red `systemMessage` is added (Bash) or omitted (file tools) — see denyJson.
//
// This is the ONE boundary every blocking path passes through, which is why the per-invocation audit
// line is flushed HERE: the `calls/` stream carries the outcome of its own call, and the outcome is not
// known until this point. `rule` names what blocked (or '-'), for the line's `rule=` field.
//
// `fault` is the L0 fault code when the block IS an L0 fault (S/C/Y — the three decided here in JS,
// where the sh shim's own `fault=` stamp can never reach), else '-'. Stamping it at this ONE boundary is
// what makes `grep 'fault=S'` span the whole audit trail rather than only its sh half.
//
// It RETURNS the outcome instead of writing it. The write and the exit belong to HookApp, which owns
// the injected stdout/exit ports — that separation is what lets a golden test read the exact bytes a
// composed run produces. `denyForCrash` (hook-core) needs the value rather than the throw, because it
// is already INSIDE the catch that would swallow one.
// webpieces-disable no-function-outside-class -- the Claude Code PreToolUse protocol boundary; module-scope beside denyJson/allowOutcome by design, and it must stay callable from a tree too broken to build a DI container.
export function denyOutcome(event: AgentHookEvent | null, reason: string, rule: string = '-', fault: string = L0_FAULT_NONE): HookOutcome {
    // BLOCK_AI_CURE: every deny that reaches this boundary prints a cure the agent can act on — the
    // L0 faults name a command on the allowlist, and the L1/L2 guards print theirs. A deny needing a
    // HUMAN would have to say so at its own site; none does today, and inventing one here would be
    // guessing at the boundary rather than at the decision.
    invocationLog.finish('BLOCK_AI_CURE', rule, fault);
    return new HookOutcome(denyJson(event, reason) + '\n', 0);
}

// The ALLOW, as a value. No JSON — a silent exit 0 is "allow" in the PreToolUse protocol.
//
// NOT exported, deliberately, where denyOutcome is: `denyForCrash` genuinely needs the deny in value
// form because it is already inside the catch a throw would land in, and nothing needs the allow that
// way. An exported one would be a second, externally-pickable spelling of "allow" sitting three lines
// from `emitAllow` — precisely the shape an agent picks by accident.
// webpieces-disable no-function-outside-class -- the PreToolUse protocol boundary, module-scope beside denyJson/denyOutcome by design, and it must stay callable from a tree too broken to build a DI container
function allowOutcome(): HookOutcome {
    invocationLog.finish('ALLOW', '-');
    return new HookOutcome('', 0);
}

// Block the tool call and END the invocation from wherever in the pipeline we are — see HookTerminated
// for why the terminal control flow is a throw now rather than a `process.exit` at the call site. Still
// typed `never`: nothing after a call to this runs.
// webpieces-disable no-function-outside-class -- the Claude Code PreToolUse protocol boundary; module-scope beside denyJson/emitAllow by design, and it must stay callable from a tree too broken to build a DI container.
export function emitDeny(event: AgentHookEvent | null, reason: string, rule: string = '-', fault: string = L0_FAULT_NONE): never {
    throw new HookTerminated(denyOutcome(event, reason, rule, fault));
}

// Allow the tool call and END the invocation. See emitDeny.
// webpieces-disable no-function-outside-class -- the PreToolUse protocol boundary, module-scope beside denyJson/emitDeny by design, and it must stay callable from a tree too broken to build a DI container
export function emitAllow(): never {
    throw new HookTerminated(allowOutcome());
}
