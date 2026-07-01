#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-setup-ai-hooks) — do not edit; re-running the installer
# overwrites this file. Checked in on purpose so the hook degrades gracefully when node_modules is
# absent. Safe to delete along with the matching .claude/settings.json entries if you remove
# @webpieces/ai-hook-rules.
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
echo "  [ai-hook-rules] $BIN_NAME not installed — run 'pnpm install' to enable webpieces AI guards." >&2
echo "  (If you removed @webpieces/ai-hook-rules on purpose, delete this hook from .claude/settings.json.)" >&2
exit 0                       # non-blocking: inform, never block the dev's tool call
