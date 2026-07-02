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
