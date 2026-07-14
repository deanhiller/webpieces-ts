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
# Read the tool payload ONCE, up front. The shim no longer exec's the bin (see RUN_BIN_SH), so it must
# forward stdin to the bin itself — and it needs the payload again on the fail-closed path below.
PAYLOAD="$(cat)"
BROKEN_BIN=""
CRASH_MSG=""
if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ]; then
  OUT_FILE="${TMPDIR:-/tmp}/wp-ai-hook-out.$$"
  ERR_FILE="${TMPDIR:-/tmp}/wp-ai-hook-err.$$"
  printf '%s' "$PAYLOAD" | "$BIN" "$@" >"$OUT_FILE" 2>"$ERR_FILE"
  RC=$?
  if [ "$RC" = 0 ] || [ "$RC" = 2 ]; then
    cat "$OUT_FILE"                      # the guard's real decision — verbatim
    cat "$ERR_FILE" >&2
    rm -f "$OUT_FILE" "$ERR_FILE" 2>/dev/null
    exit "$RC"
  fi
  # Crashed. Keep the most useful stderr line for the human. Strip " and backslash so the text stays a
  # valid JSON string, and cap the length so a giant node stack cannot blow up the deny payload.
  CRASH_MSG="$(grep -m1 'Cannot find module' "$ERR_FILE" 2>/dev/null | tr -d '"\\' | cut -c1-120)"
  [ -n "$CRASH_MSG" ] || CRASH_MSG="$(head -n1 "$ERR_FILE" 2>/dev/null | tr -d '"\\' | cut -c1-120)"
  [ -n "$CRASH_MSG" ] || CRASH_MSG="exit code $RC, no stderr"
  rm -f "$OUT_FILE" "$ERR_FILE" 2>/dev/null
  BROKEN_BIN=1
fi
# Bin missing (fresh clone before install) OR a version drift (stale node_modules) OR the bin is
# installed but CRASHED (corrupt node_modules). The webpieces guards CANNOT safely run.
# Before failing closed, peek at the tool payload and let ONLY package-manager install/recovery commands
# through: the assistant's own Bash tool routes through this hook too, so blocking everything would
# deadlock the very commands (pnpm install / rm -rf node_modules && pnpm install) that re-enable the
# guards. A silent exit 0 = "allow" in the PreToolUse protocol; the guards resume once the tree is sane.
CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
TOOL="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
# Best-effort audit trail of every decision the fail-closed shim makes WHILE THE GUARDS ARE DOWN, so a
# human can inspect after something odd (an install that was denied, or one that slipped through). One
# tab-separated line per call → <root>/.webpieces/logs/ai-hook-shim.log (gitignored). NEVER breaks or
# blocks the hook: all writes are best-effort (|| true) and go to a file, never to stdout (stdout is
# the PreToolUse decision channel — a stray byte there would corrupt allow/deny).
LOG_DIR="$ROOT/.webpieces/logs"
wp_log() {                   # $1 = decision label (ALLOW-INSTALL | DENY | DENY-STALE | DENY-BROKEN)
  { mkdir -p "$LOG_DIR" 2>/dev/null && printf '%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$BIN_NAME" "$TOOL" "$1" "$CMD" >> "$LOG_DIR/ai-hook-shim.log"; } 2>/dev/null || true
}
DENY_LABEL="DENY"
[ -n "$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"    # version drift, not a missing bin
[ -n "$BROKEN_BIN" ] && DENY_LABEL="DENY-BROKEN"  # bin present but CRASHED (corrupt node_modules)
if printf '%s' "$CMD" | grep -Eq '^(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*[[:space:]]*$' || printf '%s' "$CMD" | grep -Eq '^rm[[:space:]]+-rf[[:space:]]+(\./)?node_modules/?([[:space:]]*&&[[:space:]]*(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?[[:space:]]*$'; then
  wp_log ALLOW-INSTALL       # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the installer/recovery so the assistant can break the deadlock
fi
wp_log "$DENY_LABEL"         # every fail-closed block (…-STALE = drift, …-BROKEN = crash) for inspection
if [ -n "$BROKEN_BIN" ]; then
  # Report (do NOT auto-clean) the orphaned pnpm staging dirs — a package pnpm was mid-way through
  # writing is left behind as <name>_<pid>_<hash>. Their presence is the fingerprint of an install that
  # was killed, which is what corrupts node_modules in the first place. Best-effort; never fatal.
  STAGING_N="$(ls "$ROOT/node_modules" 2>/dev/null | grep -Ec '_[0-9a-f]+_[0-9a-f]+$' || true)"
  STAGING_NOTE=""
  if [ "${STAGING_N:-0}" -gt 0 ] 2>/dev/null; then
    STAGING_NOTE=" Also found $STAGING_N orphaned pnpm staging dirs (name_pid_hash) under node_modules - the fingerprint of an install that was killed mid-write."
  fi
  REASON="❌ webpieces guards are DOWN and every tool call is BLOCKED: ${BIN_NAME} is installed but CRASHED ($CRASH_MSG). Your node_modules is corrupt or partially written, so the guards cannot run - and they must NOT be silently skipped. NOTE: a plain 'pnpm install' will NOT fix this; pnpm sees the correct version on disk and skips the broken package. Run exactly this, then retry: rm -rf node_modules && pnpm install${STAGING_NOTE}"
elif [ -n "$DRIFT_PKG" ]; then
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
