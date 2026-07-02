#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-setup-ai-hooks) — do not edit; the installer AND the running
# guards binary both overwrite this file (self-healing) from renderShim(). Checked in on purpose so the
# hook has a stable, committed entry point even when node_modules is absent. Safe to delete along with
# the matching .claude/settings.json entries if you remove @webpieces/ai-hook-rules.
#
# Usage (wired into .claude/settings.json): sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin-name>
BIN_NAME="$1"
shift
# Resolve the bin relative to THIS script (…/<root>/.claude/webpieces/ai-hook.sh → <root>), not the
# caller's cwd — the hook can be invoked from any directory (a subdir, or a nested clone).
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
BIN="$ROOT/node_modules/.bin/$BIN_NAME"
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"          # exec preserves stdin — hooks receive the tool payload as JSON on stdin
fi
# Bin missing (fresh clone before install, or a broken install). The webpieces guards CANNOT run.
# Before failing closed, peek at the tool payload and let ONLY package-manager install commands
# through: the assistant's own Bash tool routes through this hook too, so blocking everything would
# deadlock the one command (pnpm/npm install) that re-enables the guards. A silent exit 0 = "allow"
# in the PreToolUse protocol; the guards resume automatically once node_modules is present.
PAYLOAD="$(cat)"
CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
if printf '%s' "$CMD" | grep -Eq '^(pnpm|npm) install([[:space:]]+--[A-Za-z][A-Za-z-]*)*[[:space:]]*$'; then
  exit 0                     # allow the installer so the assistant can self-heal the deadlock
fi
# Not an installer command → FAIL CLOSED. Deny via Claude Code's PreToolUse JSON protocol
# (permissionDecision "deny" on stdout, then exit 0) rather than a bare "exit 2". BOTH block the call,
# but only the JSON's permissionDecisionReason is surfaced to the human in the terminal UI (and to the
# model) — an exit-2 stderr message is NOT reliably shown on a blocked call, so the user would never
# see the "run pnpm install" fix. This still fails closed: "deny" blocks the tool; it is not the silent
# allow a plain exit 0 with no JSON would be. The reason is a single JSON string with no
# double-quotes/backslashes, so it stays valid JSON after ${BIN_NAME} is substituted in.
REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry. (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
