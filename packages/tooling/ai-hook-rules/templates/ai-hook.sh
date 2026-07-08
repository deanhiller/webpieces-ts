#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-install-ai-hooks) — do not edit; the installer AND the running
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
# --- webpieces version-drift guard (pure sh — runs even when the installed guard bin is stale) -----
# The committed shim is version-agnostic, so it keeps working right after a git pull, BEFORE the
# matching pnpm install. That is exactly when node_modules can be STALE: an OLDER @webpieces than
# package.json now pins, whose outdated validator rejects the NEWER webpieces.config.json with baffling
# "unknown rule" errors. Detect that drift HERE (before exec'ing the possibly-stale bin): compare every
# EXACT-pinned @webpieces/* version in the root package.json against the version actually installed in
# node_modules; the first mismatch wins. Range specs (^ ~ workspace:*) are skipped, so they never
# false-positive; best-effort — a version we cannot read is skipped. On drift we fall through to the
# SAME fail-closed path as a missing bin (allow only pnpm install, deny the rest).
DRIFT_PKG=""
DRIFT_DECLARED=""
DRIFT_INSTALLED=""
if [ -f "$ROOT/package.json" ]; then
  while IFS=' ' read -r WP_NAME WP_DECL; do
    [ -n "$WP_NAME" ] || continue
    WP_MANIFEST="$ROOT/node_modules/@webpieces/$WP_NAME/package.json"
    [ -f "$WP_MANIFEST" ] || continue
    WP_INST="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WP_MANIFEST" | head -n1)"
    [ -n "$WP_INST" ] || continue
    if [ "$WP_DECL" != "$WP_INST" ]; then
      DRIFT_PKG="@webpieces/$WP_NAME"
      DRIFT_DECLARED="$WP_DECL"
      DRIFT_INSTALLED="$WP_INST"
      break
    fi
  done <<WPEOF
$(sed -n 's/.*"@webpieces\/\([A-Za-z0-9._-]*\)"[[:space:]]*:[[:space:]]*"\([0-9][0-9A-Za-z.-]*\)".*/\1 \2/p' "$ROOT/package.json")
WPEOF
fi
if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]; then
  exec "$BIN" "$@"          # exec preserves stdin — hooks receive the tool payload as JSON on stdin
fi
# Bin missing (fresh clone before install, or a broken install) OR a version drift (stale node_modules).
# The webpieces guards CANNOT safely run.
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
DENY_LABEL="DENY"
[ -n "$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"   # version drift, not a missing bin
if printf '%s' "$CMD" | grep -Eq '^(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*[[:space:]]*$'; then
  wp_log ALLOW-INSTALL       # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the installer so the assistant can self-heal the deadlock
fi
wp_log "$DENY_LABEL"         # record every fail-closed block (…-STALE = version drift) for inspection
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
if [ -n "$DRIFT_PKG" ]; then
  REASON="❌ webpieces is out of date: package.json pins $DRIFT_PKG@$DRIFT_DECLARED but node_modules has $DRIFT_INSTALLED. This hook rejects every call except 'pnpm install' because your installed webpieces is older than webpieces.config.json requires. Please run 'pnpm install' now, then retry."
else
  REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry. (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
fi
if [ "$TOOL" = "Bash" ]; then
  BS='\'                     # one literal backslash, so the \u001b escape never sits in this source
  ESC="${BS}u001b"          # the 6 chars: backslash u 0 0 1 b — Claude Code parses \u001b → ESC
  printf '{"systemMessage":"%s🛑 %s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "${ESC}[31;1m" "$REASON" "${ESC}[0m" "$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
fi
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
