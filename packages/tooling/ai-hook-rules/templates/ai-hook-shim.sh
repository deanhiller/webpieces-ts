#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-setup-ai-hooks) — do not edit; re-running the installer
# overwrites this file. Checked in on purpose so the hook has a stable, committed entry point even
# when node_modules is absent. Safe to delete along with the matching .claude/settings.json entries
# if you remove @webpieces/ai-hook-rules.
#
# Usage (wired into .claude/settings.json): ./.claude/webpieces/ai-hook.sh <bin-name>
#
# This template mirrors renderShim() in src/bin/setup.ts, which is the source of truth the installer
# actually writes into a consumer repo. It lives here for reference / code review.
BIN_NAME="$1"
shift
BIN="./node_modules/.bin/$BIN_NAME"
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"          # exec preserves stdin — hooks receive the tool payload as JSON on stdin
fi
# Bin missing (fresh clone before install, or a broken install). The webpieces guards CANNOT run,
# so FAIL CLOSED — Claude Code treats exit 2 as "block this tool call". Exiting 0 here would let
# every Write/Edit/Bash through with all guards silently disabled, which is exactly what we must not
# do. Tell the human to install; their own terminal 'pnpm install' does not go through this hook.
echo "❌ @webpieces/ai-hook-rules is declared in package.json but is not installed ($BIN_NAME not found)." >&2
echo "   Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry." >&2
echo "   (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)" >&2
exit 2                       # fail closed: block until the guards can actually run
