#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-setup-ai-hooks) — do not edit; re-running the installer
# overwrites this file. Checked in on purpose so the hook has a stable, committed entry point even
# when node_modules is absent. Safe to delete along with the matching .claude/settings.json entries
# if you remove @webpieces/ai-hook-rules.
#
# Usage (wired into .claude/settings.json): "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin-name>
#
# This template mirrors renderShim() in src/bin/setup.ts, which is the source of truth the installer
# actually writes into a consumer repo. It lives here for reference / code review; keep it in sync.
BIN_NAME="$1"
shift
# Resolve the bin relative to THIS script (…/<root>/.claude/webpieces/ai-hook.sh → <root>), not the
# caller's cwd — the hook can be invoked from any directory (a subdir, or a nested clone).
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BIN="$ROOT/node_modules/.bin/$BIN_NAME"
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"          # exec preserves stdin — hooks receive the tool payload as JSON on stdin
fi
# Bin missing (fresh clone before install, or a broken install). The webpieces guards CANNOT run, so
# FAIL CLOSED — deny the tool call. We deny via Claude Code's PreToolUse JSON protocol
# (permissionDecision "deny" on stdout, then exit 0) rather than a bare "exit 2". BOTH block the call,
# but only the JSON's permissionDecisionReason is surfaced to the human in the terminal UI (and to the
# model) — an exit-2 stderr message is NOT reliably shown on a blocked call, so the user would never
# see the "run pnpm install" fix (they'd just see the tool's optimistic action summary). This still
# fails closed: permissionDecision "deny" blocks the tool; it is not silently allowed like a plain
# exit 0 would be. Tell the human to install; their own terminal 'pnpm install' does not go through
# this hook. The reason is a single JSON string with no double-quotes/backslashes, so it stays valid
# JSON after ${BIN_NAME} (always wp-ai-rules-hook / wp-ai-guards-hook) is substituted in.
REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry. (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
