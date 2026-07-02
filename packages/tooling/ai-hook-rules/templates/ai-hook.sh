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
TOOL="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
# Best-effort audit trail of every decision the fail-closed shim makes WHILE THE GUARDS ARE DOWN, so a
# human can inspect after something odd (an install that was denied, or one that slipped through). One
# tab-separated line per call → <root>/.webpieces/logs/ai-hook-shim.log (gitignored). NEVER breaks or
# blocks the hook: all writes are best-effort (|| true) and go to a file, never to stdout (stdout is
# the PreToolUse decision channel — a stray byte there would corrupt allow/deny).
LOG_DIR="$ROOT/.webpieces/logs"
wp_log() {                   # $1 = decision label (ALLOW-INSTALL | DENY)
  { mkdir -p "$LOG_DIR" 2>/dev/null && printf '%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$BIN_NAME" "$TOOL" "$1" "$CMD" >> "$LOG_DIR/ai-hook-shim.log"; } 2>/dev/null || true
}
if printf '%s' "$CMD" | grep -Eq '^(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*[[:space:]]*$'; then
  wp_log ALLOW-INSTALL       # record the self-heal we let through
  exit 0                     # allow the installer so the assistant can self-heal the deadlock
fi
wp_log DENY                  # record every fail-closed block for later inspection
# Not an installer command → FAIL CLOSED. Deny via Claude Code's PreToolUse JSON protocol
# (permissionDecision "deny" on stdout, then exit 0) rather than a bare "exit 2". BOTH block the call,
# but the reason must be made visible, and HOW depends on the tool (verified by live tests; the docs
# are wrong here):
#   - Bash deny:  permissionDecisionReason is NOT shown to the human — ONLY a top-level systemMessage
#                 is, and it honors ANSI. So for Bash we emit systemMessage wrapped in ANSI red so the
#                 "run pnpm install" fix is visible (today, on Bash, it is invisible).
#   - Write/Edit/MultiEdit deny: permissionDecisionReason renders as a RED "Error:" block natively —
#                 no systemMessage needed (a second line would be redundant).
#   - NEVER exit 2 (stdout JSON ignored; stderr not reliably shown on a blocked Bash call).
# The ESC is emitted as the literal 6-char JSON escape \u001b (built via ${BS} so no raw ESC byte and
# no \uXXXX sits in this source); Claude Code's JSON parser turns \u001b into ESC. The reason is a
# single JSON string with no double-quotes/backslashes, so it stays valid JSON after ${BIN_NAME} subs.
REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry. (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
if [ "$TOOL" = "Bash" ]; then
  BS='\'                     # one literal backslash, so the \u001b escape never sits in this source
  ESC="${BS}u001b"          # the 6 chars: backslash u 0 0 1 b — Claude Code parses \u001b → ESC
  printf '{"systemMessage":"%s🛑 %s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "${ESC}[31;1m" "$REASON" "${ESC}[0m" "$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
fi
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
