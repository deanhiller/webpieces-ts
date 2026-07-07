# Bug Reports

## Bug: Blocking PreToolUse hook does not surface its "how to fix" error message

**Date:** 2026-07-02
**Reported from project:** monorepo-nx1
**Severity:** Medium (agent + user get stuck with no actionable reason)

### Summary
When the webpieces PreToolUse guard hook (`.claude/webpieces/ai-hook.sh
wp-ai-guards-hook`) blocks a `Bash` tool call, the hook's stderr — which contains
the explanation AND the fix instructions (`Run 'pnpm install' ...`) — is NOT
surfaced to the assistant/user. Instead the tool call rendered a misleading
success-looking summary (`Listed 1 directory`), so neither the human nor the
agent could see WHY it was blocked or HOW to fix it.

### What the user saw (rendered transcript)
```
The Bash hook is blocking commands. Let me use Glob instead.

  Listed 1 directory          <-- misleading: looks like `ls` succeeded

Bash is fully blocked by the webpieces hook. Let me load a search tool.
```

The `Listed 1 directory` line corresponds to a blocked `Bash(ls libraries)`
call. The command was blocked by the hook (exit 2), but the UI showed the
normal action summary and hid the hook's stderr.

### The hook DOES print a fix message
`.claude/webpieces/ai-hook.sh` (lines 17–24) intentionally fails closed and
writes actionable instructions to stderr before `exit 2`:

```sh
echo "❌ @webpieces/ai-hook-rules is declared in package.json but is not installed ($BIN_NAME not found)." >&2
echo "   Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry." >&2
echo "   (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)" >&2
exit 2
```

So the fix instructions exist and are emitted — the problem is they are not
being displayed on the blocked tool call.

### Expected
A `Bash` call blocked by a PreToolUse hook (exit 2) should display the hook's
stderr — the reason and the `Run 'pnpm install'` fix instructions — instead of
(or in addition to) a generic `Listed 1 directory` action summary.

### Actual
- Blocked `Bash(ls libraries)` rendered as `Listed 1 directory`, with no error
  and no fix instructions visible.
- The block reason / fix text (hook stderr) was suppressed in the UI.

### Impact
Both the user and the agent are left guessing. The agent gave up on Bash and
fell back to other tools instead of telling the user to run `pnpm install`,
purely because the hook's actionable stderr was not shown.

### Notes / possible cause
- Likely the UI derives the tool-call label from the command (`ls` →
  "Listed 1 directory") and does not swap to an error view when a PreToolUse
  hook denies the call with exit 2 + stderr.
- Check the render path for `PreToolUse` deny (exit 2): the hook's stderr should
  replace/annotate the optimistic action summary.

### Environment
- Model: claude-opus-4-8[1m]
- CWD: /Users/deanhiller/workspace/onetablet/monorepo-nx1
- Hook: `.claude/settings.json` PreToolUse, matcher `Write|Edit|MultiEdit|Bash`,
  command `"$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" wp-ai-guards-hook`
- Trigger condition: `@webpieces/ai-hook-rules` not installed
  (`node_modules/.bin/wp-ai-guards-hook` missing), so the hook fails closed.

---

## Bug: Config-validation error message omits the "you may edit webpieces.config.json" escape hatch (released 0.3.241)

**Date:** 2026-07-07
**Reported from project:** ctoteachings/monorepo1
**Severity:** Medium (agent believes it is fully deadlocked and asks the user instead of fixing the config itself)
**Status:** Already fixed in source (PR #288 `dean/config-validation-fix-message`) but NOT in the released version monorepo1 has installed (`@webpieces/rules-config` **0.3.241**). Needs a release + dependency bump.

### Summary
`webpieces.config.json` contained a stale rule key `framework-tag` (a genuinely
removed/renamed rule). The `wp-ai-guards-hook` PreToolUse guard correctly fails
closed and blocks every `Bash`/`Write`/`Edit`, EXCEPT edits to
`webpieces.config.json` itself (the fix target — see `runner.ts:89` /
`hook-core.ts:112`: "Always allow edits to webpieces.config.json").

But the error text surfaced to the agent (from released 0.3.241) never mentions
that exemption. So the agent concluded it was completely stuck — it could not
write the plan file, could not run bash — and escalated to the user asking
permission to fix the config, when it could have simply edited
`webpieces.config.json` and unblocked itself immediately.

### What the agent/user saw (released 0.3.241)
```
webpieces.config.json has 1 validation error(s) — fix ALL, then retry:

  • [framework-tag] Unknown rule — not a built-in rule and no "rulesDir" is
    configured to supply custom rules. Remove the "framework-tag" key from
    webpieces.config.json (it is likely a removed or renamed rule, or a typo).
```
This is `formatConfigErrorsBanner` + `unknownRuleError` from installed
`node_modules/@webpieces/rules-config/src/{load-config.js,validate-config.js}`
@ 0.3.241.

### Two defects in that message
1. **No "edits are always allowed" instruction.** The banner is just
   header + bullet(s). It never tells the reader that editing
   `webpieces.config.json` is exempt from the guard, so an AI reads
   "everything is blocked" and deadlocks.
2. **Leads with "Remove the key".** `unknownRuleError` tells the reader to
   delete the key first. The #1 real cause is version skew (installed guard is a
   release BEHIND the config), where deleting destroys valid config. Should lead
   with `pnpm install`.

### Already fixed in source (verify the release includes it)
Current `packages/tooling/rules-config/src/` (version `0.0.0-dev`, via PR #288)
already fixes BOTH:
- `load-config.ts` `formatConfigErrorsBanner` now appends a "👉 FIX ORDER"
  footer; **step 3**: "edit webpieces.config.json (edits to it are ALWAYS
  allowed) to fix each • above."  (load-config.ts:138–146)
- `validate-config.ts` `unknownRuleError` now leads with "run `pnpm install`
  first ... Only if it is STILL unknown after a fresh install ... remove the
  key."  (validate-config.ts:151–159)

### Action
Cut a release of `@webpieces/rules-config` (+ dependents) that includes PR #288,
then bump `@webpieces/*` in ctoteachings/monorepo1 (currently pinned to 0.3.241)
so the improved banner ships to consumers. No code change needed — just release
+ consumer upgrade. Optionally add a regression test asserting the banner
contains the "edits ... ALWAYS allowed" line.

### Environment
- Model: claude-opus-4-8[1m]
- CWD: /Users/deanhiller/workspace/ctoteachings/monorepo1
- Installed: `@webpieces/rules-config` 0.3.241, `@webpieces/ai-hook-rules` 0.3.241
- Source fix present at: /Users/deanhiller/workspace/personal/webpieces-ts40 (PR #288, 0.0.0-dev)
