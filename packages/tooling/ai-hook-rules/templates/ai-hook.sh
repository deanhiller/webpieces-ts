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
#
# pnpm CATALOGS: a dep pinned via "catalog:" / "catalog:<name>" carries NO digit-version in package.json,
# so the old scraper matched nothing and the guard was BLIND to it — DRIFT_PKG stayed empty and the
# stale bin ran (the 2026-07 "0.3.369 vs 0.4.405" incident). Resolve those specs through the top-level
# `catalogs:` block of pnpm-lock.yaml (catalog -> pkg -> resolved version) before comparing.
DRIFT_PKG=""
DRIFT_DECLARED=""
DRIFT_INSTALLED=""
if [ -f "$ROOT/package.json" ]; then
  # Only when a @webpieces dep actually uses a "catalog:" spec do we scan the (possibly huge) lockfile —
  # a cheap grep keeps the common, catalog-free repo from paying that cost on every tool call. One awk
  # pass over pnpm-lock.yaml emits "<catalog> <@webpieces/pkg> <version>" lines for the sh lookup below;
  # \047 is a single quote (so this awk program carries none and stays safely single-quotable in sh).
  WP_CATALOGS=""
  if grep -Eq '"@webpieces/[^"]*"[[:space:]]*:[[:space:]]*"catalog:' "$ROOT/package.json" 2>/dev/null && [ -f "$ROOT/pnpm-lock.yaml" ]; then
    WP_CATALOGS="$(awk '
      { n=0; while (substr($0,n+1,1)==" ") n++; c=substr($0,n+1) }
      c=="" { next }
      n==0 { incat=(c ~ /^catalogs: *$/)?1:0; cat=""; pkg=""; next }
      incat==0 { next }
      n==2 { cat=c; sub(/:.*/,"",cat); pkg=""; next }
      n==4 { pkg=c; sub(/: *$/,"",pkg); gsub(/["\047]/,"",pkg); next }
      n==6 && substr(pkg,1,11)=="@webpieces/" && c ~ /^version:/ {
        v=c; sub(/^version: */,"",v); gsub(/["\047 ]/,"",v);
        if (cat!="" && v!="") print cat " " pkg " " v
      }
    ' "$ROOT/pnpm-lock.yaml" 2>/dev/null)"
  fi
  while IFS=' ' read -r WP_NAME WP_DECL; do
    [ -n "$WP_NAME" ] || continue
    # Resolve the declared spec to an EXACT version, or skip it: ranges (^ ~ workspace:*) never drift,
    # and a catalog spec we cannot resolve is best-effort skipped rather than guessed.
    case "$WP_DECL" in
      catalog:*)
        WP_CAT="${WP_DECL#catalog:}"; [ -n "$WP_CAT" ] || WP_CAT="default"
        WP_DECL="$(printf '%s\n' "$WP_CATALOGS" | awk -v c="$WP_CAT" -v p="@webpieces/$WP_NAME" '$1==c && $2==p {print $3; exit}')"
        [ -n "$WP_DECL" ] || continue ;;
      [0-9]*) : ;;
      *) continue ;;
    esac
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
$(sed -n 's/.*"@webpieces\/\([A-Za-z0-9._-]*\)"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1 \2/p' "$ROOT/package.json")
WPEOF
fi
# --- webpieces committed-shim self-guard (this file is webpieces-managed; a revert/edit is a mistake) --
# THIS file (.claude/webpieces/ai-hook.sh) is GENERATED from the installed @webpieces/ai-hook-rules
# template and committed only so the hook has a stable entry point when node_modules is absent. If it no
# longer matches the installed template, someone reverted or hand-edited it (the exact mistake that hides
# the fix behind a stale escape hatch) — its fail-closed logic can no longer be trusted, so we fail closed
# and make the cure explicit rather than silently running possibly-stale guard logic. Best-effort: only
# when the template is actually present (skip on a fresh clone / global install), and only when there is
# NO version drift (that has its own, more precise message; comparing bytes across versions is just noise).
SHIM_STALE=""
WP_TEMPLATE="$ROOT/node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh"
if [ -z "$DRIFT_PKG" ] && [ -f "$WP_TEMPLATE" ] && ! cmp -s "$0" "$WP_TEMPLATE"; then
  SHIM_STALE=1
fi
# Read the tool payload ONCE, up front. The shim no longer exec's the bin (see RUN_BIN_SH), so it must
# forward stdin to the bin itself — and it needs the payload again on the fail-closed path below.
PAYLOAD="$(cat)"
BROKEN_BIN=""
CRASH_MSG=""
if [ -x "$BIN" ] && [ -z "$DRIFT_PKG" ] && [ -z "$SHIM_STALE" ]; then
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
[ -n "$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"        # version drift, not a missing bin
[ -n "$SHIM_STALE" ] && DENY_LABEL="DENY-SHIM-STALE"  # committed shim reverted/edited (self-guard)
[ -n "$BROKEN_BIN" ] && DENY_LABEL="DENY-BROKEN"      # bin present but CRASHED (corrupt node_modules)
if printf '%s' "$CMD" | grep -Eq '^(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*[[:space:]]*$' || printf '%s' "$CMD" | grep -Eq '^rm[[:space:]]+-rf[[:space:]]+(\./)?node_modules/?([[:space:]]*&&[[:space:]]*(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?[[:space:]]*$'; then
  wp_log ALLOW-INSTALL       # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the installer/recovery so the assistant can break the deadlock
fi
# Always let the shim-regen cure through: wp-upgrade-shim rewrites the committed shim from the installed
# template, so it is the ONLY fix for a self-guard block — denying it would deadlock the assistant.
if printf '%s' "$CMD" | grep -Eq '^(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-upgrade-shim[[:space:]]*$'; then
  wp_log ALLOW-UPGRADE-SHIM  # record the shim regen we let through (re-arms the committed shim)
  exit 0
fi
# DRIFT ONLY: let the git sync commands through. When the PIN is the stale side (a checkout behind
# origin), 'pnpm install' DOWNGRADES and 'git pull' is the only cure — denying it deadlocks the
# assistant against its own fix. Pointless for a missing/broken bin, so it stays gated on drift.
if [ -n "$DRIFT_PKG" ] && printf '%s' "$CMD" | grep -Eq '^git[[:space:]]+(pull|fetch|merge)([[:space:]]+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*[[:space:]]*$'; then
  wp_log ALLOW-SYNC          # record the git sync we let through (may be what re-syncs the pin)
  exit 0
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
elif [ -n "$SHIM_STALE" ]; then
  # The committed shim differs from the installed template — reverted or hand-edited. State plainly that
  # this file is webpieces-MANAGED so the reader does not "fix" it by reverting again, and name the ONE
  # allowlisted command that re-arms it.
  REASON="❌ webpieces-managed file was changed: .claude/webpieces/ai-hook.sh no longer matches the installed @webpieces/ai-hook-rules template (it was reverted or hand-edited). This file is GENERATED and committed by webpieces - it must NOT be reverted or edited by hand, and its fail-closed guard logic cannot be trusted while it differs. Every tool call is blocked until it is regenerated. Run exactly this, then retry: pnpm exec wp-upgrade-shim (rewrites the committed shim from the installed template; do NOT revert it again - if you meant to remove @webpieces/ai-hook-rules, delete its hooks from .claude/settings.json instead)."
elif [ -n "$DRIFT_PKG" ]; then
  # State the two versions and let the reader judge which is stale — do NOT assert a direction. The
  # check is a plain !=, so it fires BOTH ways, and the old text always claimed node_modules was the
  # older side. When it is actually the NEWER side (a checkout behind origin), that text sent people
  # to 'pnpm install', which DOWNGRADES them further from correct.
  REASON="❌ webpieces version drift: package.json pins $DRIFT_PKG@$DRIFT_DECLARED but node_modules has $DRIFT_INSTALLED. Every call is blocked until they agree. WHICH ONE IS STALE decides the fix - compare the two versions above: (1) pin is NEWER than node_modules (you just pulled/switched to a branch pinning a newer webpieces) -> run 'pnpm install' to catch node_modules up. (2) pin is OLDER than node_modules (your checkout is behind origin, so the PIN is the stale side) -> 'pnpm install' would DOWNGRADE you: run 'git pull' first (or 'git merge --ff-only origin/main'), THEN 'pnpm install'. git pull/fetch/merge are allowed while this guard is up."
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
