#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-install-ai-hooks) — do not edit. This file is GENERATED from
# renderShim() and is intentionally VERSION-AGNOSTIC and byte-STABLE across releases: it carries no
# version stamp, so it only changes when its own logic changes. The installed guards binary is what
# checks that this committed copy still matches renderShim() (the committed-shim self-guard); if you
# revert or hand-edit this file the binary fails closed and names the cure. Checked in on purpose so
# the hook has a stable entry point even when node_modules is absent. Safe to delete along with the
# matching .claude/settings.json entries if you remove @webpieces/ai-hook-rules.
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
FILE="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
# Best-effort audit trail of every decision the fail-closed shim makes WHILE THE GUARDS ARE DOWN, so a
# human can inspect after something odd (an install that was denied, or one that slipped through). One
# tab-separated line per call → <root>/.webpieces/logs/ai-hook-shim.log (gitignored). NEVER breaks or
# blocks the hook: all writes are best-effort (|| true) and go to a file, never to stdout (stdout is
# the PreToolUse decision channel — a stray byte there would corrupt allow/deny).
LOG_DIR="$ROOT/.webpieces/logs"
wp_log() {                   # $1 = label (ALLOW-CURE|ALLOW-READ|ALLOW-CONFIG|DENY|DENY-STALE|DENY-BROKEN)
  { mkdir -p "$LOG_DIR" 2>/dev/null && printf '%s\t%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$BIN_NAME" "$TOOL" "$1" "$CMD" >> "$LOG_DIR/ai-hook-shim.log"; } 2>/dev/null || true
}
DENY_LABEL="DENY"
[ -n "$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"        # version drift, not a missing bin
[ -n "$BROKEN_BIN" ] && DENY_LABEL="DENY-BROKEN"      # bin present but CRASHED (corrupt node_modules)
# THE L0 ALLOWLIST, entry order identical to isAllowed(). No fault is consulted: a cure that cannot
# help a given fault also cannot hurt it, and gating each entry on a fault is what produced the four
# defects recorded above L0_ALLOW_ERE.
if [ "$TOOL" = "Read" ]; then
  wp_log ALLOW-READ          # you must be able to read to work out how to fix this
  exit 0
fi
case "$FILE" in
  */webpieces.config.json|webpieces.config.json)
    wp_log ALLOW-CONFIG      # the always-allowed recovery target — every guard is configured from it
    exit 0 ;;
esac
if printf '%s' "$CMD" | grep -Eq '^(cd[[:space:]]+([A-Za-z0-9._/@~+-]+|'\''[^'\'']+'\'')[[:space:]]*&&[[:space:]]*)?((pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*|rm[[:space:]]+-rf[[:space:]]+(\./)?node_modules/?([[:space:]]*&&[[:space:]]*(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?|git[[:space:]]+(pull|fetch)([[:space:]]+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*|(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-upgrade-shim|cp[[:space:]]+(\./)?node_modules/@webpieces/ai-hook-rules/templates/ai-hook\.sh[[:space:]]+(\./)?\.claude/webpieces/ai-hook\.sh|(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-install-ai-hooks([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)([[:space:]]+2>(&1|/dev/null))?([[:space:]]*\|[[:space:]]*(tail|head)([[:space:]]+-(n[[:space:]]+)?[0-9]+)?)?[[:space:]]*$'; then
  wp_log ALLOW-CURE          # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the cure so the assistant can break the deadlock
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
  REASON="❌ webpieces guards are DOWN and every OTHER tool call is BLOCKED: ${BIN_NAME} is installed but CRASHED ($CRASH_MSG). Your node_modules is corrupt or partially written, so the guards cannot run - and they must NOT be silently skipped. NOTE: a plain 'pnpm install' will NOT fix this; pnpm sees the correct version on disk and skips the broken package. THIS IS NOT A DEADLOCK: the option below is explicitly ALLOWED through while this guard is up, so run it YOURSELF rather than handing it to the human. OPTION 1 - run EXACTLY this command, then retry: 'rm -rf node_modules && pnpm install'. Type the option you pick EXACTLY as written, character for character, and run NOTHING else on that line. Seriously: do NOT append && anything (not even a harmless && git status), do NOT wrap it in a subshell. The allowlist is anchored to the ENTIRE command, so anything you bolt on makes it a DIFFERENT command and it WILL be rejected again - which is not the guard refusing its own cure. If an option already contains &&, that && is part of the command: keep it, and still add nothing beyond it. The only additions tolerated are a LEADING cd <dir> && (needed to run the cure in a linked worktree, since the harness resets a cwd that left the workspace and puts you back in the primary clone - that one IS accepted), a trailing 2>&1, and a pipe into tail/head (e.g. cd /path/to/worktree && pnpm install 2>&1 | tail -20).${STAGING_NOTE}"
elif [ -n "$DRIFT_PKG" ]; then
  # The 'how do I get current' half comes from SyncFlowGuidance so it cannot contradict the guards.
  # It used to name 'git merge --ff-only origin/main' and assert that merge is allowed while this guard
  # is up — the ONE command redirect-how-to-merge-main blocks in every form. An AI that obeyed the
  # drift message got hard-blocked by the other guard with no path forward, which is how improvised
  # 'git reset --hard' workarounds get invented. The SYNC allowlist no longer accepts merge either, so
  # the text and the allowlist now agree instead of the text warning against what the list permits.
  #
  # State the two versions and let the reader judge which is stale — do NOT assert a direction. The
  # check is a plain !=, so it fires BOTH ways, and the old text always claimed node_modules was the
  # older side. When it is actually the NEWER side (a checkout behind origin), that text sent people
  # to 'pnpm install', which DOWNGRADES them further from correct.
  #
  # But "which side is stale" is NOT the same question as "what clears the block". 'pnpm install' clears
  # fault D in BOTH directions by definition — it makes installed == pin. The old text never said so, so
  # a reader on the OPTION 2 branch could not tell whether it was even permitted to install. The only
  # real question is whether the PIN is the version you WANT, and that has three legitimate answers,
  # including deliberately staying on the older code (a checkout + feature branch + install to
  # downgrade). Saying that out loud stops it being improvised as a reset --hard.
  #
  # The FEATURE-BRANCH case is why featureBranchSyncAdvice() is a separate method: wp-start-update is
  # NOT on the L0 allowlist (a 3-point merge is not a tooling-integrity cure), so it can only be offered
  # AFTER the install that clears this block and re-arms the guards. Prescribing it while the block is
  # up would be the same deny-names-a-denied-command deadlock this module exists to prevent.
  REASON="❌ webpieces version drift: package.json pins $DRIFT_PKG@$DRIFT_DECLARED but node_modules has $DRIFT_INSTALLED. Every OTHER call is blocked until they agree. 'pnpm install' ALWAYS clears this block, in BOTH directions - it makes node_modules match the pin by definition, and it is allowed through while this guard is up. The only question is whether the PIN is the version you WANT, so compare the two versions above. OPTION 1 (node_modules is OLDER than the pin - you just pulled or switched to a branch pinning a newer webpieces) - run EXACTLY this command and you are done: 'pnpm install'. OPTION 2 (node_modules is NEWER than the pin - your checkout is behind origin, so the PIN is the stale side, and a bare 'pnpm install' would DOWNGRADE you) - if you are ON MAIN, get the checkout current FIRST and then install: run 'git pull origin main', and after it succeeds run 'pnpm install'. OPTION 3 (node_modules is NEWER than the pin and you deliberately want to stay on the OLD code) - check out the exact commit you want, create a feature branch from it, then run 'pnpm install' to bring node_modules DOWN to the version that commit pinned. That is a legitimate choice, not a mistake - the downgrade is the point. ON A FEATURE BRANCH: a bare 'pnpm install' aligns node_modules to YOUR BRANCH pin, which is usually what you want, and it clears this block. If you actually want main's newer @webpieces, still run 'pnpm install' FIRST to clear the drift and re-arm the guards, and only THEN sync from main normally. To sync a FEATURE branch from main use pnpm wp-start-update (no PR open) or pnpm wp-start-upsert-pr (a PR is open). Do NOT try to run those two while this block is up: they are not on the allowlist, and they do not need to be - the install comes first. To get main itself current: ON main, run 'git pull origin main'. In a linked worktree (main is checked out in the primary clone, so checkout main fatals there), run 'git fetch origin main' and branch off origin/main. Do NOT reach for git merge --ff-only / git reset --hard / git checkout -B main: merge and rebase are blocked in EVERY form by redirect-how-to-merge-main, and the reset/-B forms silently throw away commits. git pull and git fetch are allowed while this guard is up and are the cure here. git merge is NOT allowed - not by this guard and not by redirect-how-to-merge-main once the guards are back - because main is merged ONLY through the 3-point fork merge: 'pnpm wp-start-update', or 'pnpm wp-start-upsert-pr' when a PR is already open. Type the option you pick EXACTLY as written, character for character, and run NOTHING else on that line. Seriously: do NOT append && anything (not even a harmless && git status), do NOT wrap it in a subshell. The allowlist is anchored to the ENTIRE command, so anything you bolt on makes it a DIFFERENT command and it WILL be rejected again - which is not the guard refusing its own cure. If an option already contains &&, that && is part of the command: keep it, and still add nothing beyond it. The only additions tolerated are a LEADING cd <dir> && (needed to run the cure in a linked worktree, since the harness resets a cwd that left the workspace and puts you back in the primary clone - that one IS accepted), a trailing 2>&1, and a pipe into tail/head (e.g. cd /path/to/worktree && pnpm install 2>&1 | tail -20)."
else
  # A LINKED WORKTREE is the overwhelmingly common way to land here with a perfectly healthy repo:
  # git gives the new worktree a .git FILE (the primary clone has a .git directory) and copies no
  # node_modules, so the very first tool call in a brand-new worktree fail-closes on a missing bin.
  # Naming that explicitly turns a baffling "not installed" into a one-command fix, and the HERE is
  # load-bearing: installing in the primary clone does nothing for this tree.
  WORKTREE_NOTE=""
  if [ -f "$ROOT/.git" ]; then
    WORKTREE_NOTE=" NOTE: $ROOT is a LINKED WORKTREE - git does not copy node_modules into a new worktree, so this is expected on a fresh one. Run 'pnpm install' HERE (in this worktree), not in the primary clone."
  fi
  REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (${BIN_NAME} not found). OPTION 1 - run EXACTLY this command to enable the webpieces AI guards, then retry: 'pnpm install'. Type the option you pick EXACTLY as written, character for character, and run NOTHING else on that line. Seriously: do NOT append && anything (not even a harmless && git status), do NOT wrap it in a subshell. The allowlist is anchored to the ENTIRE command, so anything you bolt on makes it a DIFFERENT command and it WILL be rejected again - which is not the guard refusing its own cure. If an option already contains &&, that && is part of the command: keep it, and still add nothing beyond it. The only additions tolerated are a LEADING cd <dir> && (needed to run the cure in a linked worktree, since the harness resets a cwd that left the workspace and puts you back in the primary clone - that one IS accepted), a trailing 2>&1, and a pipe into tail/head (e.g. cd /path/to/worktree && pnpm install 2>&1 | tail -20).${WORKTREE_NOTE} (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
fi
if [ "$TOOL" = "Bash" ]; then
  BS='\'                     # one literal backslash, so the \u001b escape never sits in this source
  ESC="${BS}u001b"          # the 6 chars: backslash u 0 0 1 b — Claude Code parses \u001b → ESC
  printf '{"systemMessage":"%s🛑 %s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "${ESC}[31;1m" "$REASON" "${ESC}[0m" "$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
fi
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
