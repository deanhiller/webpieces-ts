# Fix Plan — Make Bash guard denials VISIBLE (and red) in the Claude Code UI

Status: **empirically verified** against Claude Code v2.1.x (July 2026). Ready to implement.

> ANSI escapes below are written as the literal JSON escape `` (backslash-u-0-0-1-b). Emit exactly
> that sequence into the JSON string — do NOT paste a raw ESC (0x1b) byte into source or JSON.

## TL;DR

Our guard denials are **invisible to the human when they block a `Bash` tool call** — the user sees
only a grey collapsed "Ran 1 shell command" line and never learns *why* the command was blocked (e.g.
the "run `pnpm install`" fallback, or a policy violation). On a **Bash** deny, Claude Code does **not**
surface `permissionDecisionReason` to the user at all.

The fix: on a **Bash** deny, also emit a top-level **`systemMessage`** whose text is wrapped in **ANSI
red** (`[31;1m … [0m`). `systemMessage` is the only field Claude Code renders to the user on
a Bash deny, and it passes ANSI escapes through to the terminal — so the message shows up **red and
prominent** instead of invisible.

**Apply the ANSI-red `systemMessage` to Bash denials ONLY.** `Write`/`Edit`/`MultiEdit` denials already
render `permissionDecisionReason` as a red "Error:" block, so they need **no change** — adding a
`systemMessage` there would just be a redundant second red line.

---

## Background — how we got here

The original bug: a fresh clone (no `node_modules`) blocks every `Write/Edit/Bash` via the fail-closed
shim, telling the human to run `pnpm install`. On **Write/Edit** that message rendered as a red "Error:"
block. On **Bash** the human saw **nothing** — just a grey line — so they had no idea why their command
silently did nothing, or how to fix it.

We initially assumed `permissionDecisionReason` (exit-0 JSON `permissionDecision:"deny"`) was
user-visible. It is **not**, for Bash. We proved the real behavior by live-testing every mechanism.

## Empirical findings (verified by live tests — DO NOT re-derive from docs; the docs are wrong here)

For a **PreToolUse deny**, rendering depends on **the tool type**, not just the field:

| Mechanism (exit code) | Tool | Model receives | **Human sees in terminal UI** |
|---|---|---|---|
| JSON `permissionDecisionReason` only, **exit 0** | **Bash** | reason | **nothing** (grey collapsed line) |
| JSON `systemMessage` (+reason), **exit 0** | **Bash** | reason | grey `PreToolUse:Bash says: …` line |
| **`systemMessage` with ANSI** `[31;1m…[0m`, **exit 0** | **Bash** | reason | **RED text** in the `…says:` line ✅ |
| stderr, **exit 2** | **Bash** | stderr (as "hook error") | grey "Ran 1 shell command" — **no reason shown** |
| stderr with ANSI, **exit 2** | **Bash** | stderr (ANSI intact) | **nothing shown to the user** |
| JSON `permissionDecisionReason`, **exit 0** | **Write/Edit** | reason | **RED "Error:" block** (already fine) |
| JSON `systemMessage` + `permissionDecisionReason`, **exit 0** | **Write/Edit** | reason | grey `…says:` line **+ RED "Error:" block** |

Key conclusions:
1. **`permissionDecisionReason` is NOT shown to the user on a Bash deny.** It IS shown (red) on Write/Edit.
2. **`systemMessage` is the only user-visible field on a Bash deny** — and it renders grey by default.
3. **ANSI escape codes inside `systemMessage` are passed through to the terminal** → we can force red.
4. **`exit 2` + stderr shows the user nothing for Bash** (and exit 2 makes Claude Code ignore stdout
   JSON, so you cannot combine exit 2 with `systemMessage`/`permissionDecision`). Do NOT use exit 2.
5. This is a **known, "closed / not planned"** Claude Code asymmetry — GitHub issues #31592, #40380,
   #17356. We are not waiting on an upstream fix; the ANSI-in-`systemMessage` trick is our fix.

`` is a **valid JSON string escape**, so the deny JSON still parses cleanly (verified — the deny
fired and the model received the reason). Never emit a raw ESC byte (0x1b) into JSON.

---

## The fix — tool-conditional deny payload

Emit on **exit 0** (keep failing closed via `permissionDecision:"deny"`). Branch on `tool_name` (the
hook already has it in the payload):

**Bash deny** (NEW — adds the ANSI-red `systemMessage`):
```json
{
  "systemMessage": "[31;1m🛑 <reason>[0m",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<reason>"
  }
}
```

**Write / Edit / MultiEdit deny** (UNCHANGED — no `systemMessage`; already red natively):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "<reason>"
  }
}
```

- `systemMessage` (ANSI-red) → **red + visible to the human on Bash**. Added for **Bash only**.
- `permissionDecisionReason` → always present, stays **plain text**: it's what the model reads, and what
  Write/Edit renders red natively. **Never wrap `permissionDecisionReason` in ANSI** — on Write/Edit it
  lands inside a red "Error:" block already, and raw escapes there risk showing as visible junk.
- `permissionDecision:"deny"` + exit 0 → blocks the tool, fail-closed (not a silent allow), for all tools.

### Concrete edits

1. **`src/adapters/claude-code-response.ts` — `denyJson()` (lines 11-19) + `emitDeny()`**
   - Thread the **tool name** through: `denyJson(reason: string, toolName: string)` and
     `emitDeny(reason: string, toolName: string)`.
   - Add the top-level `systemMessage` (reason wrapped in `[31;1m` … `[0m`) **only when
     `toolName === 'Bash'`**; omit it for every other tool. Put the wrapping in one helper, e.g.
     `redSystemMessage(reason)` returning the `[31;1m🛑 <reason>[0m` string, so the escape
     lives in exactly one place.
   - Keep `permissionDecisionReason` as the plain reason for every tool.
   - Update the file header comment (lines 1-9) — see task 4.

2. **`src/adapters/hook-core.ts` — pass the tool name to each deny.**
   - The engine already has the parsed payload (`tool_name` / `tool_input`). Pass that `tool_name`
     into every `emitDeny(reason, toolName)` call (bash guard block, file-rule block, fail-closed
     crash paths). Bash guard → `'Bash'` (gets the red `systemMessage`); file/Write rule → its
     Write/Edit tool name (no `systemMessage`).

3. **`src/bin/setup.ts` — `renderShim()` "not installed" fallback (the `printf '{…}'` deny)**
   - The shim already parses `"command"` from the payload; also parse `"tool_name"`.
   - **Only when `tool_name` is `Bash`**, emit the deny JSON with the ANSI-red `systemMessage` (embed
     the escape as the literal 6 chars `` inside the single-quoted JSON string that `printf '%s'`
     emits — Claude Code's JSON parser converts `` → ESC). For `Write`/`Edit`/`MultiEdit`, emit
     the existing deny JSON **without** `systemMessage`. Keep the reason free of `"`/`\` so JSON stays
     valid after `${BIN_NAME}` substitution.
   - Result: a fresh-clone **Bash** command shows the red "run `pnpm install`" message (today:
     invisible); a fresh-clone **Write/Edit** still shows its red "Error:" block as before.
   - NOTE: if this branch/build has moved `renderShim()` + `healShim()` into a separate `src/bin/shim.ts`
     (as the published build has), apply the change there instead — wherever `renderShim()` currently
     lives is the single source of truth the self-heal writes from.

4. **Document the findings IN the scripts (REQUIRED — do not skip).**
   Add a concise comment block — the verified rendering matrix + the "why ANSI in `systemMessage`, Bash
   only" rationale — to each script that emits a deny, so no future maintainer re-derives it from the
   (wrong) docs:
   - `src/adapters/claude-code-response.ts` — above `denyJson()`.
   - `src/bin/setup.ts` (or `src/bin/shim.ts`) — above the fallback deny `printf`, AND inside the
     rendered shim body as an `sh` comment (so the committed `.claude/webpieces/ai-hook.sh` itself
     carries the explanation).
   Each comment must state, at minimum:
   - Bash deny: `permissionDecisionReason` is NOT user-visible; only `systemMessage` is; it honors
     ANSI, so we wrap it red — **Bash only**.
   - Write/Edit deny: `permissionDecisionReason` renders red natively; we add **no** `systemMessage`.
   - Do NOT use `exit 2` (stdout JSON ignored; stderr invisible to the user on Bash).
   - `` is a valid JSON escape (safe); never emit a raw ESC byte.
   - Reference: Claude Code GitHub issues #31592, #40380, #17356 (asymmetry "closed / not planned").

### Robustness caveats (bake these into the implementation)

- **Degrade gracefully.** ANSI-in-`systemMessage` is *undocumented* Claude Code behavior and could be
  stripped by a future release or a non-TTY/CI renderer. The message must stay fully readable with the
  color removed — carry meaning in a plain prefix (e.g. `🛑` + the reason); red is a bonus, not
  load-bearing.
- **Keep JSON valid.** Use `` (JSON escape), never a raw 0x1b byte. Reason strings must remain
  quote/backslash-free in the shim path.
- **Color only `systemMessage`, and only for Bash.** Never color `permissionDecisionReason`.

### Tests to add/update

- `src/adapters/claude-code-response.spec.ts`:
  - `denyJson(reason, 'Bash')` → valid JSON; `hookSpecificOutput.permissionDecision === 'deny'`;
    top-level `systemMessage` **starts with** `[31` and **ends with** `[0m` and contains
    `reason`; `permissionDecisionReason === reason` (plain, no ANSI).
  - `denyJson(reason, 'Edit')` (and `'Write'`, `'MultiEdit'`) → **no** `systemMessage` key; still valid
    JSON with `permissionDecision === 'deny'` and plain `permissionDecisionReason`.
- `src/bin/setup.spec.ts`: rendered shim's fallback branches — Bash path JSON contains a `systemMessage`
  with `[31` … `[0m` and stays valid after `${BIN_NAME}` substitution; Write/Edit path has
  no `systemMessage`.

### Manual verification (the only way to confirm rendering)

In a repo wired to these hooks: trigger a **Bash** deny (policy-violating command, or remove the guards
bin to hit the fallback) and confirm the terminal shows a **red** `PreToolUse:Bash says: …` line — not a
grey/invisible one. Trigger a **Write/Edit** deny and confirm it is still the single red "Error:" block
(no extra `systemMessage` line) and still blocked.

---

## Out of scope / notes

- No change to `emitAllow()` or the installer-allowlist logic.
- This does not make the Bash deny use the exact same red "Error:" block as Write/Edit — Claude Code
  reserves that block for Write/Edit and there is no hook field to trigger it for Bash. ANSI-red
  `systemMessage` (Bash only) is the closest achievable, and a large improvement over today's invisible
  state.
</content>
