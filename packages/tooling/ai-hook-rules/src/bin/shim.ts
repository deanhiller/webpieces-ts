import * as fs from 'fs';
import * as path from 'path';

import { CONFIG_FILENAME } from '@webpieces/rules-config';

import { toError } from '../core/to-error';
import {
    L0_ALLOW_ERE_SH, RECOVERY_CMD, INSTALL_HOOKS_CMD, UPGRADE_SHIM_CMD, RESTORE_SHIM_CMD,
    INSTALL_HOOKS_ALLOW_JS, UPGRADE_SHIM_ALLOW_JS, RESTORE_SHIM_ALLOW_JS,
} from './l0-allowlist';

// The allowlist moved to ./l0-allowlist (this module was over the file-size limit); re-exported here so
// every existing `from './shim'` import keeps working and there is still ONE name to import L0 by.
export * from './l0-allowlist';

// ---------------------------------------------------------------------------
// The single checked-in shim (.claude/webpieces/ai-hook.sh). Both project hooks point at it, passing
// their bin name as the first arg. settings.json points here (not at the bare bin) so a missing bin
// (fresh clone, package removed) yields a friendly message instead of the raw `sh: No such file or
// directory` on every Write/Edit/Bash tool call. `.claude` is committed, so the shim survives even
// when node_modules does not.
//
// This module is the SINGLE SOURCE OF TRUTH for the shim body + the installer allowlist. The
// installer (setup.ts) renders it on install; the running guards binary re-renders and self-heals it
// (healShim) so the committed .sh can never go stale — no human ever hand-edits it.
// ---------------------------------------------------------------------------
export const SHIM_MARKER = '.claude/webpieces/ai-hook.sh';

// NO VERSION STAMP (removed 2026-07-24). The shim used to carry a per-release `# webpieces shim
// version: <v> (<sha>)` on line 2, rewritten by scripts/set-version.sh at publish. It was a pure
// human-eyeball diagnostic — nothing reads it (the deny's version note comes from the installed
// package.json) — but it made the committed shim go byte-different on EVERY release even when the
// logic was identical, so the committed-shim self-guard tripped on every upgrade over a comment (the
// DENY-SHIM-STALE churn). It also carried its own hazard: stamp one of the two lockstep artifacts and
// not the other and every consumer fail-closes forever on a phantom edit. Deleting it makes the shim
// byte-STABLE across releases, so the self-guard (now in the binary) fires only on a genuine logic
// change or a real tamper — which is what lets `pnpm install` be the fix for almost everything.

export function shimPath(projectRoot: string): string {
    return path.join(projectRoot, '.claude', 'webpieces', 'ai-hook.sh');
}


// ---------------------------------------------------------------------------
// HOW EVERY DENY MUST SPELL ITS CURE (added 2026-07-23, from a live audit-log post-mortem).
//
// The guards were right, the message was right, and the assistant STILL handed the block back to the
// human — because of one appended clause. From .webpieces/logs/ai-hook-shim.log in a consumer repo:
//
//   DENY-SHIM-STALE  cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh && git status --short
//
// That is the prescribed cure, verbatim, plus `&& git status --short`. Every allowlist here is anchored
// to `$`, so the trailing `&&` made it a different command and it was denied — and the assistant read
// its own denial as proof that "the guard blocks the very command that fixes it" and stopped.
//
// Widening the allowlist to accept `&& <anything>` is NOT the fix: these are fail-CLOSED escape hatches
// whose entire security property is that no shell operator can ride along (`cp … && rm -rf /`). The fix
// is to stop the assistant appending in the first place — so every deny that prescribes a command now
// (a) numbers its cures as OPTIONs, (b) quotes each one so the exact bytes are unambiguous, and
// (c) carries this rule, which says in plain words that adding `&&` gets it rejected again.
//
// CONSTRAINT on every string that reaches a deny REASON: no double quotes and no backslashes. The
// reason is interpolated into a `REASON="…"` shell assignment and then printf'd into a JSON string, so
// a `"` would break BOTH. Hence single quotes around the commands here — do not "improve" them.
// ---------------------------------------------------------------------------
// LENGTH IS PART OF THE FIX (2026-08-03). This block used to run ~153 words and was repeated verbatim
// in D, X and K — in X it was ~85% of the whole message, which buries the one sentence that matters.
// It now states the rule and the three tolerated additions, and nothing else: the tolerated set is
// exactly what CD_PREFIX_ERE + CAPTURE_TAIL_ERE accept (the single-quoted path branch of CD_PREFIX_ERE
// is why "single-quote a path containing spaces" is named), so this text cannot promise more or less
// than the allowlist grants.
export const NO_CHAINING_RULE =
    'Run it EXACTLY as written - the allowlist matches the whole command, so appending anything ' +
    '(even && git status) makes it a different command and it is rejected; that is not the guard ' +
    'blocking its own cure. Only these may be added: a leading cd <dir> && (single-quote a path ' +
    'containing spaces), a trailing 2>&1, and | tail -N.';

// Normal template literal (not String.raw): it carries #235's shell escapes verbatim (\${BIN_NAME},
// \$REASON, \\n for the deny JSON) AND my sed backslashes (doubled: \\(, \\), \\1, [^"\\\\]). The
// grep pattern is interpolated from INSTALLER_ALLOW_ERE (its value has no backslashes).
// Shell fragment: the version-drift guard (see its own block comment). Extracted to a module const so
// renderShim() stays within the method-line budget; it is spliced back in verbatim, byte-for-byte.
const VERSION_DRIFT_GUARD_SH = `# --- webpieces version-drift guard (pure sh — runs even when the installed guard bin is stale) -----
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
# \`catalogs:\` block of pnpm-lock.yaml (catalog -> pkg -> resolved version) before comparing.
DRIFT_PKG=""
DRIFT_DECLARED=""
DRIFT_INSTALLED=""
if [ -f "$ROOT/package.json" ]; then
  # Only when a @webpieces dep actually uses a "catalog:" spec do we scan the (possibly huge) lockfile —
  # a cheap grep keeps the common, catalog-free repo from paying that cost on every tool call. One awk
  # pass over pnpm-lock.yaml emits "<catalog> <@webpieces/pkg> <version>" lines for the sh lookup below;
  # \\047 is a single quote (so this awk program carries none and stays safely single-quotable in sh).
  WP_CATALOGS=""
  if grep -Eq '"@webpieces/[^"]*"[[:space:]]*:[[:space:]]*"catalog:' "$ROOT/package.json" 2>/dev/null && [ -f "$ROOT/pnpm-lock.yaml" ]; then
    WP_CATALOGS="$(awk '
      { n=0; while (substr($0,n+1,1)==" ") n++; c=substr($0,n+1) }
      c=="" { next }
      n==0 { incat=(c ~ /^catalogs: *$/)?1:0; cat=""; pkg=""; next }
      incat==0 { next }
      n==2 { cat=c; sub(/:.*/,"",cat); pkg=""; next }
      n==4 { pkg=c; sub(/: *$/,"",pkg); gsub(/["\\047]/,"",pkg); next }
      n==6 && substr(pkg,1,11)=="@webpieces/" && c ~ /^version:/ {
        v=c; sub(/^version: */,"",v); gsub(/["\\047 ]/,"",v);
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
        WP_CAT="\${WP_DECL#catalog:}"; [ -n "$WP_CAT" ] || WP_CAT="default"
        WP_DECL="$(printf '%s\\n' "$WP_CATALOGS" | awk -v c="$WP_CAT" -v p="@webpieces/$WP_NAME" '$1==c && $2==p {print $3; exit}')"
        [ -n "$WP_DECL" ] || continue ;;
      [0-9]*) : ;;
      *) continue ;;
    esac
    WP_MANIFEST="$ROOT/node_modules/@webpieces/$WP_NAME/package.json"
    [ -f "$WP_MANIFEST" ] || continue
    WP_INST="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$WP_MANIFEST" | head -n1)"
    [ -n "$WP_INST" ] || continue
    if [ "$WP_DECL" != "$WP_INST" ]; then
      DRIFT_PKG="@webpieces/$WP_NAME"
      DRIFT_DECLARED="$WP_DECL"
      DRIFT_INSTALLED="$WP_INST"
      break
    fi
  done <<WPEOF
$(sed -n 's/.*"@webpieces\\/\\([A-Za-z0-9._-]*\\)"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1 \\2/p' "$ROOT/package.json")
WPEOF
fi`;

// Shell fragment: run the installed guard bin and INSPECT its outcome, instead of exec'ing it.
//
// THE BUG THIS FIXES (guards silently fail-OPEN): the shim used to `exec "$BIN"`. exec REPLACES this
// shim process, so once the bin was executable the shim was GONE and could no longer make a decision.
// That is fine when the bin runs — but the bin can be INSTALLED YET BROKEN: a corrupt/partially-written
// node_modules makes node die at require() time with MODULE_NOT_FOUND, exiting 1. And in the PreToolUse
// protocol ONLY exit 2 blocks: any other non-zero is a NON-BLOCKING error, so Claude Code prints
// "Failed with non-blocking status code" and RUNS THE TOOL CALL ANYWAY — the guard is silently skipped.
// Result: every Write/Edit/Bash went UNGUARDED, for as long as node_modules stayed corrupt. The shim
// handled "bin missing" and "bin stale", but never "bin present and CRASHES" — the third failure mode.
//
// So: do not exec. Run the bin with the payload on stdin and branch on its exit code.
//   rc 0 | 2      → a REAL decision (allow / block). Relay stdout, stderr and the code byte-faithfully.
//   anything else → the guard CRASHED. Fall through to the fail-CLOSED path (BROKEN_BIN=1).
// stdout/stderr go through temp FILES, not $(command substitution), so the bin's bytes reach Claude
// Code exactly as written — command substitution strips trailing newlines and would corrupt the
// decision JSON. Reading the payload up-front ($PAYLOAD) is what replaces exec's stdin passthrough.
const RUN_BIN_SH = `if [ -x "\$BIN" ] && [ -z "\$DRIFT_PKG" ]; then
  OUT_FILE="\${TMPDIR:-/tmp}/wp-ai-hook-out.\$\$"
  ERR_FILE="\${TMPDIR:-/tmp}/wp-ai-hook-err.\$\$"
  printf '%s' "\$PAYLOAD" | "\$BIN" "\$@" >"\$OUT_FILE" 2>"\$ERR_FILE"
  RC=\$?
  if [ "\$RC" = 0 ] || [ "\$RC" = 2 ]; then
    cat "\$OUT_FILE"                      # the guard's real decision — verbatim
    cat "\$ERR_FILE" >&2
    rm -f "\$OUT_FILE" "\$ERR_FILE" 2>/dev/null
    exit "\$RC"
  fi
  # Crashed. Keep the most useful stderr line for the human. Strip " and backslash so the text stays a
  # valid JSON string, and cap the length so a giant node stack cannot blow up the deny payload.
  CRASH_MSG="\$(grep -m1 'Cannot find module' "\$ERR_FILE" 2>/dev/null | tr -d '"\\\\' | cut -c1-120)"
  [ -n "\$CRASH_MSG" ] || CRASH_MSG="\$(head -n1 "\$ERR_FILE" 2>/dev/null | tr -d '"\\\\' | cut -c1-120)"
  [ -n "\$CRASH_MSG" ] || CRASH_MSG="exit code \$RC, no stderr"
  rm -f "\$OUT_FILE" "\$ERR_FILE" 2>/dev/null
  BROKEN_BIN=1
fi`;

// Shell fragment: the guards are DOWN (missing | stale | crashed). Parse the payload, audit-log the
// decision, and let THE L0 ALLOWLIST through — everything else falls to the deny below.
//
// This asks the identical question isAllowed() asks in JS, in the same order: Read, then the
// webpieces.config.json target, then the one command union (L0_ALLOW_ERE). The sh and JS halves exist
// because D/X/K are decided BEFORE the bin runs (a stale/missing/broken validator cannot validate
// itself) while S/C/Y are decided inside it — one model, two enforcement points.
//
// NOTE the documented asymmetry: here the bin is never executed, so an allowed Read is TERMINAL and
// read-stale-guard does not run. In JS the same entry falls through and it does. See isAllowed().
const TRIAGE_SH = `CMD="\$(printf '%s' "\$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
TOOL="\$(printf '%s' "\$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
FILE="\$(printf '%s' "\$PAYLOAD" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
# Best-effort audit trail of every decision the fail-closed shim makes WHILE THE GUARDS ARE DOWN, so a
# human can inspect after something odd (an install that was denied, or one that slipped through). One
# tab-separated line per call → <root>/.webpieces/logs/ai-hook-shim.log (gitignored). NEVER breaks or
# blocks the hook: all writes are best-effort (|| true) and go to a file, never to stdout (stdout is
# the PreToolUse decision channel — a stray byte there would corrupt allow/deny).
LOG_DIR="\$ROOT/.webpieces/logs"
wp_log() {                   # \$1 = label (ALLOW-CURE|ALLOW-READ|ALLOW-CONFIG|DENY|DENY-STALE|DENY-BROKEN)
  { mkdir -p "\$LOG_DIR" 2>/dev/null && printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "\$BIN_NAME" "\$TOOL" "\$1" "\$CMD" >> "\$LOG_DIR/ai-hook-shim.log"; } 2>/dev/null || true
}
DENY_LABEL="DENY"
[ -n "\$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"        # version drift, not a missing bin
[ -n "\$BROKEN_BIN" ] && DENY_LABEL="DENY-BROKEN"      # bin present but CRASHED (corrupt node_modules)
# THE L0 ALLOWLIST, entry order identical to isAllowed(). No fault is consulted: a cure that cannot
# help a given fault also cannot hurt it, and gating each entry on a fault is what produced the four
# defects recorded above L0_ALLOW_ERE.
if [ "\$TOOL" = "Read" ]; then
  wp_log ALLOW-READ          # you must be able to read to work out how to fix this
  exit 0
fi
case "\$FILE" in
  */${CONFIG_FILENAME}|${CONFIG_FILENAME})
    wp_log ALLOW-CONFIG      # the always-allowed recovery target — every guard is configured from it
    exit 0 ;;
esac
if printf '%s' "\$CMD" | grep -Eq '${L0_ALLOW_ERE_SH}'; then
  wp_log ALLOW-CURE          # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the cure so the assistant can break the deadlock
fi
wp_log "\$DENY_LABEL"         # every fail-closed block (…-STALE = drift, …-BROKEN = crash) for inspection`;

// Shell fragment: emit the deny. FAIL CLOSED via Claude Code's PreToolUse JSON protocol
// (permissionDecision "deny" on stdout, then exit 0) rather than a bare "exit 2". BOTH block the call,
// but the reason must be made VISIBLE, and HOW depends on the tool (verified by live tests; the docs
// are wrong here):
//   - Bash deny:  permissionDecisionReason is NOT shown to the human — ONLY a top-level systemMessage
//                 is, and it honors ANSI. So for Bash we emit systemMessage wrapped in ANSI red so the
//                 recovery command is visible (without it, on Bash, it is invisible).
//   - Write/Edit/MultiEdit deny: permissionDecisionReason renders as a RED "Error:" block natively —
//                 no systemMessage needed (a second line would be redundant).
//   - NEVER exit 2 (stdout JSON ignored; stderr not reliably shown on a blocked Bash call).
// The ESC is emitted as the literal 6-char JSON escape \\u001b (built via ${BS} so no raw ESC byte and
// no \\uXXXX sits in this source); Claude Code's JSON parser turns \\u001b into ESC. The reason is a
// single JSON string with no double-quotes/backslashes, so it stays valid JSON after ${BIN_NAME} subs.
const DENY_EMIT_SH = `if [ "\$TOOL" = "Bash" ]; then
  BS='\\'                     # one literal backslash, so the \\u001b escape never sits in this source
  ESC="\${BS}u001b"          # the 6 chars: backslash u 0 0 1 b — Claude Code parses \\u001b → ESC
  printf '{"systemMessage":"%s🛑 %s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\${ESC}[31;1m" "\$REASON" "\${ESC}[0m" "\$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\$REASON"
fi
exit 0                       # decision is carried by permissionDecision "deny", not the exit code`;

// Shell fragment: pick the fail-closed deny REASON — a crashed-bin message (corrupt node_modules) vs a
// version-drift message (bin present but stale) vs the missing-bin message. Extracted alongside
// VERSION_DRIFT_GUARD_SH / RUN_BIN_SH to keep renderShim() within the method-line budget.
const DENY_REASON_SH = `if [ -n "\$BROKEN_BIN" ]; then
  # Report (do NOT auto-clean) the orphaned pnpm staging dirs — a package pnpm was mid-way through
  # writing is left behind as <name>_<pid>_<hash>. Their presence is the fingerprint of an install that
  # was killed, which is what corrupts node_modules in the first place. Best-effort; never fatal.
  STAGING_N="\$(ls "\$ROOT/node_modules" 2>/dev/null | grep -Ec '_[0-9a-f]+_[0-9a-f]+\$' || true)"
  STAGING_NOTE=""
  if [ "\${STAGING_N:-0}" -gt 0 ] 2>/dev/null; then
    STAGING_NOTE=" Also found \$STAGING_N orphaned pnpm staging dirs (name_pid_hash) under node_modules - the fingerprint of an install that was killed mid-write."   # only when N > 0
  fi
  REASON="❌ webpieces guards are DOWN and every other call is BLOCKED: \${BIN_NAME} is installed but CRASHED (\$CRASH_MSG). Your node_modules is corrupt or partially written, so the guards cannot run - and they must not be silently skipped. Run EXACTLY: '${RECOVERY_CMD}'. A bare 'pnpm install' will NOT fix this: pnpm sees the correct version on disk and skips the broken package.\${STAGING_NOTE} ${NO_CHAINING_RULE}"
elif [ -n "\$DRIFT_PKG" ]; then
  # DECIDE THE DIRECTION, do not make the reader do it (2026-08-03). The detection is a plain !=, so it
  # fires BOTH ways, and the message used to carry OPTION 1/2/3 covering every direction at once — 3343
  # chars of which only about a third was the decision. A reader on the wrong branch of that menu was
  # one misread away from a downgrade. So compare the two versions HERE and emit only the relevant half.
  #
  # WITH AWK, not \`sort -V\`: -V is a GNU extension (absent/different on BSD sort), while the shim
  # already runs an awk pass to resolve catalog: specs, so awk adds no dependency. The program compares
  # the numeric cores component-by-component; a pre-release/build suffix (-rc.1, +sha) is stripped from
  # the core, and when the cores are EQUAL the side carrying a PRE-RELEASE suffix is the older one
  # (semver precedence). Build metadata (+sha) carries NO precedence, so two versions differing only
  # there come back undecidable rather than ordered. Anything it cannot parse prints NOTHING, and an
  # empty answer falls through to the ambiguous wording below rather than guessing a direction.
  #
  # WHAT WAS DELETED, so it does not creep back: the "how to get main itself current" paragraph and the
  # "do NOT reach for git merge --ff-only / reset --hard / checkout -B main" paragraph both belong to
  # redirect-how-to-merge-main, which fires on its own with its own message; and the sentence that named
  # wp-start-update / wp-start-upsert-pr ONLY to forbid them while the block is up — naming a command
  # purely to forbid it is pure cost, and the install that clears this fault comes first regardless.
  DRIFT_DIR="\$(awk -v i="\$DRIFT_INSTALLED" -v d="\$DRIFT_DECLARED" 'BEGIN {
    iv = i; sub(/\\+.*/, "", iv); ic = iv; sub(/-.*/, "", ic); ip = substr(iv, length(ic) + 1)
    dv = d; sub(/\\+.*/, "", dv); dc = dv; sub(/-.*/, "", dc); dp = substr(dv, length(dc) + 1)
    if (ic !~ /^[0-9]+(\\.[0-9]+)*\$/ || dc !~ /^[0-9]+(\\.[0-9]+)*\$/) exit
    n = split(ic, ia, "."); m = split(dc, da, "."); k = (n > m) ? n : m
    for (x = 1; x <= k; x++) {
      av = (x <= n) ? ia[x] + 0 : 0; bv = (x <= m) ? da[x] + 0 : 0
      if (av < bv) { print "older"; exit }
      if (av > bv) { print "newer"; exit }
    }
    if (ip == dp) exit
    if (ip != "" && dp == "") print "older"
    if (ip == "" && dp != "") print "newer"
  }' 2>/dev/null)"
  if [ "\$DRIFT_DIR" = older ]; then
    REASON="❌ webpieces version drift: package.json pins \$DRIFT_PKG@\$DRIFT_DECLARED but node_modules has \$DRIFT_INSTALLED - node_modules is OLDER, so the pin is what you want. Every other call is blocked until they agree. Run EXACTLY: 'pnpm install'. ${NO_CHAINING_RULE}"
  else
    # NEWER, or undecidable — the same three choices apply either way, so the only thing the ambiguous
    # case changes is the claim about which side is stale.
    DRIFT_NOTE="node_modules is NEWER, so the PIN is the stale side and a bare 'pnpm install' DOWNGRADES you to \$DRIFT_DECLARED"
    [ "\$DRIFT_DIR" = newer ] || DRIFT_NOTE="these two versions could not be ordered automatically - compare them yourself: if node_modules is the NEWER side then the PIN is the stale side and a bare 'pnpm install' DOWNGRADES you to \$DRIFT_DECLARED"
    REASON="❌ webpieces version drift: package.json pins \$DRIFT_PKG@\$DRIFT_DECLARED but node_modules has \$DRIFT_INSTALLED - \$DRIFT_NOTE. That may be exactly what you want. Every other call is blocked until they agree. Pick one: - move forward to what origin pins: run 'git pull origin main', then 'pnpm install'. - stay on this code deliberately: run 'pnpm install' (the downgrade is the point). - on a feature branch: run 'pnpm install' (aligns to YOUR branch pin - usually right). ${NO_CHAINING_RULE}"
  fi
else
  # A LINKED WORKTREE is the overwhelmingly common way to land here with a perfectly healthy repo:
  # git gives the new worktree a .git FILE (the primary clone has a .git directory) and copies no
  # node_modules, so the very first tool call in a brand-new worktree fail-closes on a missing bin.
  # Naming that explicitly turns a baffling "not installed" into a one-command fix, and the HERE is
  # load-bearing: installing in the primary clone does nothing for this tree.
  WORKTREE_NOTE=""
  if [ -f "\$ROOT/.git" ]; then
    WORKTREE_NOTE=" NOTE: \$ROOT is a LINKED WORKTREE - git does not copy node_modules into a new worktree, so this is expected on a fresh one. Run it HERE, in this worktree, not in the primary clone."
  fi
  REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (\${BIN_NAME} not found). Run EXACTLY: 'pnpm install'.\${WORKTREE_NOTE} ${NO_CHAINING_RULE} (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
fi`;

export function renderShim(): string {
    return `#!/bin/sh
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
${VERSION_DRIFT_GUARD_SH}
# Read the tool payload ONCE, up front. The shim no longer exec's the bin (see RUN_BIN_SH), so it must
# forward stdin to the bin itself — and it needs the payload again on the fail-closed path below.
PAYLOAD="$(cat)"
BROKEN_BIN=""
CRASH_MSG=""
${RUN_BIN_SH}
# Bin missing (fresh clone before install) OR a version drift (stale node_modules) OR the bin is
# installed but CRASHED (corrupt node_modules). The webpieces guards CANNOT safely run.
# Before failing closed, peek at the tool payload and let ONLY package-manager install/recovery commands
# through: the assistant's own Bash tool routes through this hook too, so blocking everything would
# deadlock the very commands (pnpm install / rm -rf node_modules && pnpm install) that re-enable the
# guards. A silent exit 0 = "allow" in the PreToolUse protocol; the guards resume once the tree is sane.
${TRIAGE_SH}
${DENY_REASON_SH}
${DENY_EMIT_SH}
`;
}

// Find the repo root that owns the committed shim to heal: walk up from `cwd` (the invocation's
// actual dir) to the nearest ancestor holding a shim, falling back to $CLAUDE_PROJECT_DIR (which
// Claude Code exports to hooks) only if the walk finds nothing. cwd-first keeps this correct for a
// nested clone and testable (a temp root is honoured over the ambient project env). Returns null when
// no committed shim exists (e.g. a global / absolute install, which has none to heal).
//
// Exported for install-entry.ts: on a CORRUPT node_modules, healShim is the only installer step that
// can still run, so the installer must be able to tell the human whether a committed shim was actually
// there to re-arm. Pure existsSync walk — never throws, so it needs no try/catch of its own.
// webpieces-disable no-function-outside-class -- pure fs+path helper in the dependency-free shim module; it must not depend on DI (install-entry.ts relies on this loading on a corrupt tree).
export function findShimRoot(cwd: string): string | null {
    let dir = cwd;
    for (;;) {
        if (fs.existsSync(shimPath(dir))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const env = process.env['CLAUDE_PROJECT_DIR'];
    if (env && fs.existsSync(shimPath(env))) return env;
    return null;
}

// Best-effort: keep the committed shim identical to renderShim() so the fail-closed escape hatch and
// allowlist never drift. Only rewrites an EXISTING shim (never creates one) so global installs are
// untouched. NEVER throws — a self-heal must never block or crash a tool call.
//
// The overwrite itself is correct and deliberate — shim and binary are two halves of one L0 and MUST
// come from the same release (see shimStaleRecoveryDecision's header in ../adapters/hook-core).
//
// It needs no backup and no notice: the shim is a TRACKED file, so whatever it replaced is already in
// git — `git diff` shows the rewrite, and a tamper is a working-tree modification git surfaces on its
// own. In a consistent repo this is a no-op (committed shim already equals renderShim()); it earns its
// keep on the upgrade path, where bumping the pin and installing leaves the committed shim behind and
// this quietly brings it forward to be committed.
export function healShim(cwd: string): void {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const root = findShimRoot(cwd);
        if (!root) return;
        const target = shimPath(root);
        const desired = renderShim();
        if (fs.readFileSync(target, 'utf8') === desired) return;
        fs.writeFileSync(target, desired, { mode: 0o755 });
        fs.chmodSync(target, 0o755);
    } catch (err: unknown) {
        //const error = toError(err);
        // Ignore: healing is a convenience, not part of the guard decision.
    }
}

// ---------------------------------------------------------------------------
// COMMITTED-SHIM SELF-GUARD — now enforced by the guards BINARY, not the shim (moved 2026-07-24).
//
// It used to live in the rendered shim (`cmp -s "$0" "$WP_TEMPLATE"` → fail closed). That was a
// double-edged fix trap: the shim-matching logic lived IN the committed shim, so a bug in it could
// only be fixed by regenerating the committed shim — which required passing the buggy shim's own gate
// (via wp-upgrade-shim). The fix was locked behind the gate it needed to open.
//
// The drift guard MUST stay pre-binary (a stale validator can't be trusted to guard itself), but this
// check's rationale — "don't run possibly-stale shim logic" — evaporates once the check is in the
// binary: at that point the deciding code is the CURRENT binary from node_modules, not the reverted
// shim. So the shim now only checks drift + bin-presence and always hands off; the binary (hook-core)
// calls committedShimStale() and, on a mismatch, fails closed with shimStaleDenyReason() — the SAME
// OPTION 1/2/3 message — while isShimCureCommand() lets the three cures through so the AI self-heals.
// We deny + tell the AI; we do NOT silently rewrite the file under it. With the version stamp gone the
// shim is byte-stable across releases, so this fires only on a genuine logic change or a real tamper.
// ---------------------------------------------------------------------------

// True when a committed shim EXISTS but no longer equals renderShim() (reverted, hand-edited, or a shim
// whose LOGIC predates the installed binary). Missing shim → false: a fresh clone / global install has
// nothing to guard, matching the old shim's `[ -f "$WP_TEMPLATE" ]` skip. Same comparison healShim
// makes; never throws (an unreadable tree is treated as "not stale" so it can't wedge a tool call).
// webpieces-disable no-function-outside-class -- pure fs+path helper in the shim module, beside healShim/renderShim.
export function committedShimStale(cwd: string): boolean {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const root = findShimRoot(cwd);
        if (root === null) return false;
        return fs.readFileSync(shimPath(root), 'utf8') !== renderShim();
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: an unreadable tree counts as "not stale" so this never wedges a tool call
        return false;
    }
}

// True when `command` re-arms the committed shim — the two prescribed cures plus the installer, which
// also heals the shim as its first step. These are the only commands allowed through while a stale
// committed shim blocks everything else, so the AI can re-arm it. Each JS twin already tolerates
// a trailing `2>&1 | tail -N` and rejects any `&&`-chained tail (see CAPTURE_TAIL_JS_SRC).
// webpieces-disable no-function-outside-class -- pure predicate over the exported allowlist twins; belongs beside them in the shim module.
export function isShimCureCommand(command: string): boolean {
    const cmd = command.trim();
    return INSTALL_HOOKS_ALLOW_JS.test(cmd) || UPGRADE_SHIM_ALLOW_JS.test(cmd) || RESTORE_SHIM_ALLOW_JS.test(cmd);
}

// The fail-closed deny text for a stale committed shim, built from the single-source cure constants +
// NO_CHAINING_RULE. `installedVersion` names WHICH webpieces the cure re-arms to (the binary is that
// version); pass '' to omit the note rather than print an empty one. CONSTRAINT: the returned string
// must contain no `"` and no `\` — it is JSON-serialized by denyJson() (a stray quote/backslash would
// corrupt the PreToolUse decision payload, not just the text). Locked by a unit test.
// webpieces-disable no-function-outside-class -- pure string builder over exported constants; the single source of the self-guard deny text now that the sh copy is gone.
export function shimStaleDenyReason(installedVersion: string): string {
    const verNote = installedVersion ? ` (installed version ${installedVersion})` : '';
    return `❌ webpieces-managed file was changed: .claude/webpieces/ai-hook.sh no longer matches the ai-hook.sh rendered by the INSTALLED @webpieces/ai-hook-rules${verNote} (it was reverted or hand-edited). This file is GENERATED and committed by webpieces - it must NOT be reverted or edited by hand, and its fail-closed guard logic cannot be trusted while it differs. Every OTHER tool call is blocked until the two files are byte-identical again. THIS IS NOT A DEADLOCK: both options below are explicitly ALLOWED through while this guard is up, so run one YOURSELF now - do not hand it back to the human. OPTION 1 (preferred - it is the SURGICAL tool: it regenerates the shim and touches NOTHING else, no config and no settings.json, and it imports only fs/path so it runs on a broken tree; needs installed @webpieces/ai-hook-rules 0.4.408 or newer) - run EXACTLY this command: '${UPGRADE_SHIM_CMD}'. OPTION 2 (pick this when the installed @webpieces/ai-hook-rules is OLDER than 0.4.408, so wp-upgrade-shim does not exist yet - it works on every version, but Claude Code's own permission prompt may ask you to confirm the file overwrite, and that prompt is NOT this guard) - run EXACTLY this command: '${RESTORE_SHIM_CMD}'. Do NOT use the bare '${INSTALL_HOOKS_CMD}' here: this fault is shim-only, and the installer also migrates your config and wires BOTH hooks, PROMPTING for a target twice, which hangs a non-interactive session. ${NO_CHAINING_RULE} Do NOT revert the shim again - if you meant to remove @webpieces/ai-hook-rules, delete its hooks from .claude/settings.json instead.`;
}

// The shape of the fields we read out of this package's package.json.
interface ShimPackageManifest {
    readonly version?: string;
}

// The installed @webpieces/ai-hook-rules version, for shimStaleDenyReason's note. The binary IS this
// package, so it reads its OWN package.json (two dirs up from src/bin). Best-effort: '' on any failure,
// which shimStaleDenyReason renders as no note rather than a broken one.
// webpieces-disable no-function-outside-class -- pure fs helper beside the shim module's other version plumbing.
export function installedShimRulesVersion(): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as ShimPackageManifest;
        return pkg.version ?? '';
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: no readable version → shimStaleDenyReason prints no note
        return '';
    }
}
