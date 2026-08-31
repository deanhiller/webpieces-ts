#!/bin/sh
# Managed by @webpieces/ai-hook-rules (wp-install-ai-hooks) — do not edit. This file is GENERATED from
# renderShim() and is intentionally VERSION-AGNOSTIC and byte-STABLE across releases: it carries no
# version stamp, so it only changes when its own logic changes. The installed guards binary is what
# checks that this committed copy still matches renderShim() (the committed-shim self-guard); if you
# revert or hand-edit this file the binary fails closed and names the cure. Checked in on purpose so
# the hook has a stable entry point even when node_modules is absent. Safe to delete along with the
# matching .claude/settings.json entries if you remove @webpieces/ai-hook-rules.
#
# Usage (wired into .claude/settings.json, ABSOLUTE so the MAIN tree governs every tree):
#   sh "$CLAUDE_PROJECT_DIR/.claude/webpieces/ai-hook.sh" <bin-name>
BIN_NAME="$1"
shift
# Resolve the tree relative to THIS script (…/<root>/.claude/webpieces/ai-hook.sh → <root>), not the
# caller's cwd — the hook can be invoked from any directory (a subdir, or a nested clone).
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
# The JSON escapes every deny message below is assembled from (ANSI red, and the newlines that give the
# deny the same scannable shape formatReport() gives every L1/L2 deny). See ESCAPES_SH's header.
BS='\'                      # one literal backslash, so no \u001b / \n escape sits in this source
ESC="${BS}u001b"           # the 6 chars: backslash u 0 0 1 b — Claude Code parses \u001b → ESC
NL="${BS}n"                # the 2 chars: backslash n — parsed as a real newline inside the JSON string
WP_STILL_ALLOWED="Still allowed while this block is up:${NL}  - any Read${NL}  - any Write/Edit whose target is webpieces.config.json, pnpm-workspace.yaml or package.json${NL}  - every command on the L0 allowlist, including the Fix Options below${NL}  THIS IS NOT A DEADLOCK - run one YOURSELF now; do not hand it back to the human."
# The BIN is resolved by walking UP from ROOT (as Node does), and BIN_ROOT records which tree supplied
# it — the version-drift guard below compares THIS tree's pin against THAT tree's installed version.
BIN_ROOT="$ROOT"
BIN="$ROOT/node_modules/.bin/$BIN_NAME"
WP_WALK="$ROOT"
while [ ! -x "$WP_WALK/node_modules/.bin/$BIN_NAME" ]; do
  WP_UP="$(dirname -- "$WP_WALK")"
  [ "$WP_UP" != "$WP_WALK" ] || break
  WP_WALK="$WP_UP"
done
if [ -x "$WP_WALK/node_modules/.bin/$BIN_NAME" ]; then
  BIN_ROOT="$WP_WALK"
  BIN="$WP_WALK/node_modules/.bin/$BIN_NAME"
fi
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
#
# THE SAME PASS ANSWERS FAULT U (2026-08-05). Scraping root package.json is also the only way to learn
# whether @webpieces/ai-hook-rules is DECLARED at all, and that is the difference between "not installed
# yet" (X, cured by pnpm install) and "nothing asks for it" (U, where pnpm install is a guaranteed
# no-op). WP_PIN carries the first EXACT @webpieces pin found, so U's deny can prescribe the version the
# rest of the repo is already on rather than an unpinned add. Both are set BEFORE the range/catalog
# `continue`s, so a repo pinning the package by range still counts as having declared it.
DRIFT_PKG=""
DRIFT_DECLARED=""
DRIFT_INSTALLED=""
WP_HOOK_PKG_DECLARED=""
WP_PIN=""
if [ -f "$ROOT/package.json" ]; then
  # Only when a @webpieces dep actually uses a "catalog:" spec do we scan the (possibly huge) lockfile —
  # a cheap grep keeps the common, catalog-free repo from paying that cost on every tool call. One awk
  # pass over pnpm-lock.yaml emits "<catalog> <@webpieces/pkg> <version>" lines for the sh lookup below;
  # \047 is a single quote (so this awk program carries none and stays safely single-quotable in sh).
  WP_CATALOGS=""
  WP_WS_CATALOGS=""
  # THE PIN LIVES IN pnpm-workspace.yaml, and the LOCK is only the fallback (2026-08-20).
  #
  # L0 used to learn the pin from pnpm-lock.yaml's `catalogs:` alone, while L1's WebpiecesVersions.readPin
  # reads pnpm-workspace.yaml. Two notions of "the pin", and the gap is exactly where the cure lands: an
  # agent told to raise this tree's pin edits pnpm-workspace.yaml, re-runs, and L0 still reports the OLD
  # number — because only `pnpm install` rewrites the lock — so it concludes the edit did nothing and
  # reaches for something worse. Reading the workspace manifest FIRST makes the edit visible immediately.
  #
  # It resolves the same two YAML shapes readPin does, and that is not optional: a repo pinning the whole
  # @webpieces family in lockstep writes the version ONCE as `&wp 0.4.669` and aliases the rest as `*wp`,
  # so an anchor-blind read silently nulls the leg on precisely the repos that pin most carefully. Both
  # `catalog:` (the default catalog) and `catalogs:` (named ones) are walked. A value that is not a plain
  # digit-version (a range) is NOT emitted, so a loose pinner falls through to the lock rather than being
  # compared against an incomparable spec.
  if grep -Eq '"@webpieces/[^"]*"[[:space:]]*:[[:space:]]*"catalog:' "$ROOT/package.json" 2>/dev/null && [ -f "$ROOT/pnpm-workspace.yaml" ]; then
    WP_WS_CATALOGS="$(awk '
      { n=0; while (substr($0,n+1,1)==" ") n++; c=substr($0,n+1) }
      c=="" || substr(c,1,1)=="#" { next }
      {
        ai=index(c,":")
        if (ai>0) {
          av=substr(c,ai+1); sub(/^[ \t]+/,"",av)
          if (substr(av,1,1)=="&") {
            an=substr(av,2); sub(/[ \t].*/,"",an)
            sub(/^&[^ \t]+[ \t]*/,"",av)
            sub(/[ \t]+#.*/,"",av); gsub(/["\047]/,"",av); sub(/[ \t].*/,"",av)
            if (an!="" && av!="") anch[an]=av
          }
        }
      }
      n==0 { mode=(c ~ /^catalog: *$/)?1:((c ~ /^catalogs: *$/)?2:0); cat=(mode==1)?"default":""; next }
      mode==0 { next }
      mode==2 && c ~ /^[^:]+: *$/ { cat=c; sub(/: *$/,"",cat); gsub(/["\047 ]/,"",cat); next }
      {
        ki=index(c,":")
        if (ki<=0) next
        k=substr(c,1,ki-1); gsub(/["\047 ]/,"",k)
        if (substr(k,1,11)!="@webpieces/") next
        v=substr(c,ki+1); sub(/^[ \t]+/,"",v); sub(/^&[^ \t]+[ \t]*/,"",v)
        sub(/[ \t]+#.*/,"",v); gsub(/["\047]/,"",v); sub(/[ \t].*/,"",v)
        if (v=="") next
        nn++; key[nn]=cat " " k; ali[nn]=(substr(v,1,1)=="*")?substr(v,2):""; val[nn]=v
      }
      END { for (i=1;i<=nn;i++) { vv=(ali[i]=="")?val[i]:anch[ali[i]]; if (vv ~ /^[0-9]/) print key[i] " " vv } }
    ' "$ROOT/pnpm-workspace.yaml" 2>/dev/null)"
  fi
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
    # Fault U's input: the package is DECLARED (in any spec shape, in any dependency block of the root
    # manifest). Recorded before every `continue` below, so a range or catalog spec still counts.
    [ "$WP_NAME" = "ai-hook-rules" ] && WP_HOOK_PKG_DECLARED=1
    # Resolve the declared spec to an EXACT version, or skip it: ranges (^ ~ workspace:*) never drift,
    # and a catalog spec we cannot resolve is best-effort skipped rather than guessed.
    case "$WP_DECL" in
      catalog:*)
        WP_CAT="${WP_DECL#catalog:}"; [ -n "$WP_CAT" ] || WP_CAT="default"
        WP_DECL="$(printf '%s\n' "$WP_WS_CATALOGS" | awk -v c="$WP_CAT" -v p="@webpieces/$WP_NAME" '$1==c && $2==p {print $3; exit}')"
        [ -n "$WP_DECL" ] || WP_DECL="$(printf '%s\n' "$WP_CATALOGS" | awk -v c="$WP_CAT" -v p="@webpieces/$WP_NAME" '$1==c && $2==p {print $3; exit}')"
        [ -n "$WP_DECL" ] || continue ;;
      [0-9]*) : ;;
      *) continue ;;
    esac
    # The release the rest of this repo is on — what fault U's cure should pin to.
    [ -n "$WP_PIN" ] || WP_PIN="$WP_DECL"
    WP_MANIFEST="$BIN_ROOT/node_modules/@webpieces/$WP_NAME/package.json"
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
# A BORROWED BIN IS NOT SINGLE-TREE DRIFT, SO L0 MUST NOT ANSWER IT (2026-08-20).
#
# RESOLVE_BIN_SH walks UP for the bin, so in a linked worktree with no node_modules of its own BIN_ROOT
# is the MAIN tree. The scan above then compares $ROOT's DECLARED pin against $BIN_ROOT's INSTALLED
# version — a CROSS-TREE comparison it was reporting as fault D, single-tree drift. Everything
# downstream of that mislabel was wrong:
#   • the cure. 'pnpm install' cannot "align node_modules" in a tree that has none; it MANUFACTURES one,
#     at this tree's stale pin. That is precisely the state L1 row 8 (trinary-version-skew) blocks, so
#     the L0 cure created the next block. One measured agent was walked from a pin disagreement, through
#     'pnpm install' offered as "(preferred) ... usually right", to a DOWNGRADED engine and a total block.
#   • the analysis. Row 8 already reads all FOUR versions (both trees' pins and both installs), already
#     knows which direction to move, already detects a deliberate pin bump, and already carries the
#     escalate-and-STOP protocol. It could never run: ai-hook.sh hard-exits on any sh-side fault, so D
#     PREEMPTED the guard that had the right answer.
# So: when the bin came from another tree, raise NO fault here and let the binary run. D stays exactly as
# it was when ROOT == BIN_ROOT — that IS single-tree drift, and row 8 cannot see it (VersionSyncGuard
# only applies to a linked worktree compared against a DIFFERENT main tree). Coverage does not gap: if
# the two pins agree but the two installs differ, row 8's quartet still has two distinct members and it
# still fires. X / U / K are untouched — a MISSING or CRASHED bin is about the bin, not about a version.
if [ "$BIN_ROOT" != "$ROOT" ]; then
  DRIFT_PKG=""
  DRIFT_DECLARED=""
  DRIFT_INSTALLED=""
fi
# Read the tool payload ONCE, up front. The shim no longer exec's the bin (see RUN_BIN_SH), so it must
# forward stdin to the bin itself — and it needs the payload again on the fail-closed path below.
PAYLOAD="$(cat)"
CMD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
CMD_LOG="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"\\]*\).*/\1/p')"
[ -n "$CMD_LOG" ] || CMD_LOG="$CMD"
TOOL="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
WP_SID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
WP_AID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
FILE="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
WP_CWD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')"
[ -n "$WP_CWD" ] || WP_CWD="$ROOT"    # no cwd in the payload (older client, or a hand-run) → the shim's own tree
# WHICH HARNESS sent this call — the ONE discriminator, imported from ../adapters/detect-ai so the sh
# half of L0 and the JS half answer the identical question from one definition (the same twin pattern
# L0_ALLOW_ERE_SH / L0_ALLOW_JS uses). One `case`, no JSON parser: consistent with how every field
# above is `sed`-scraped, and the values are the AiType union's own strings so the twin-agreement spec
# compares them byte for byte instead of translating between two vocabularies.
case "$PAYLOAD" in *'"turn_id":'*) AI=codex ;; *) AI=claude-code ;; esac
# Best-effort AUDIT TRAIL of what L0 did with this call — every call, not just the broken ones. One
# tab-separated line per invocation into this TREE's own
# logs/L0-shim/<session>-<agent|coordinator>-<binName>.log (gitignored), so the
# observed behaviour can be diffed against the matrix in guards/L0-tooling.md. NEVER breaks or blocks the
# hook: every write is swallowed, and nothing ever goes to stdout (stdout is the PreToolUse decision
# channel — a stray byte there would corrupt allow/deny).
WP_TREE=""
WP_LOG_DIR=""
WP_PRIMARY_LOG_DIR=""
WP_TAB="$(printf '\t')"     # one real tab, so the OPTIONAL bin= field can carry its own separator
wp_resolve_log_dir() {
  _wp_rp="$(git -C "$WP_CWD" rev-parse --git-dir --git-common-dir 2>/dev/null)"
  _wp_gd="$(printf '%s\n' "$_wp_rp" | sed -n 1p)"
  _wp_cd="$(printf '%s\n' "$_wp_rp" | sed -n 2p)"
  if [ -z "$_wp_gd" ] || [ -z "$_wp_cd" ]; then
    WP_TREE=primary; WP_LOG_DIR="$WP_CWD/.webpieces/logs"
    WP_PRIMARY_LOG_DIR="$WP_LOG_DIR"; return 0
  fi
  # git prints a BARE .git from the primary clone and an absolute path from a linked worktree; the TS
  # twin runs path.resolve(cwd, printed), so do the same before comparing or taking a basename.
  case "$_wp_gd" in /*) : ;; *) _wp_gd="$WP_CWD/$_wp_gd" ;; esac
  case "$_wp_cd" in /*) : ;; *) _wp_cd="$WP_CWD/$_wp_cd" ;; esac
  # The primary clone's root is the parent of the SHARED git dir — declining any layout whose shared
  # dir is not named .git (a bare repo, --separate-git-dir), same test as primaryRoot().
  _wp_primary="$WP_CWD"
  case "$_wp_cd" in
    */.git) [ -d "${_wp_cd%/*}" ] && _wp_primary="${_wp_cd%/*}" ;;
  esac
  # The PRIMARY clone's log dir, resolved on both branches. A deny that has to tell a human WHERE the
  # audit trail is (the inverse-drift escalation in shim.ts) must be able to name both the tree it is
  # standing in and the primary — a subagent has no reach into the second one, so the deny has to quote
  # that path rather than send anyone to go and look.
  WP_PRIMARY_LOG_DIR="$_wp_primary/.webpieces/logs"
  if [ "$_wp_gd" = "$_wp_cd" ]; then
    WP_TREE=primary
    WP_LOG_DIR="$WP_PRIMARY_LOG_DIR"
  else
    # git's OWN name for the worktree (the basename of <primary>/.git/worktrees/<name>), not the
    # directory's basename — two worktrees under different parents may share a directory name.
    WP_TREE="${_wp_gd##*/}"
    WP_LOG_DIR="$_wp_primary/.webpieces/worktrees/$WP_TREE/logs"
  fi
}
wp_clean() {                 # one path segment from an UNTRUSTED payload id — twin of LogStream's segment()
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | sed -e 's/\.\{2,\}/_/g' -e 's/^\.\{1,\}/_/' | cut -c1-64
}
wp_log() {                   # $1 = L0 fault code (D|X|K|-), $2 = verdict label
  {
    [ -n "$WP_LOG_DIR" ] || wp_resolve_log_dir
    # The LAYER is the directory and the WRITER is the file — same layout the TS writers use, spelled
    # from the same constant so the two halves cannot drift apart.
    _wp_sd="$WP_LOG_DIR/L0-shim"
    mkdir -p "$_wp_sd" 2>/dev/null || return 0
    # Same writer key as LogStream.writerFile(): <session>-<agent|coordinator>-<hook>.log. $BIN_NAME
    # IS the hook discriminator here (wp-ai-guards-hook vs wp-ai-rules-hook), and Claude Code runs those
    # two IN PARALLEL on every file edit — without this prefix they append to ONE file and tear above
    # PIPE_BUF. An empty session id renders 'unknown' — this has no bare-name branch, matching
    # LogStream.writerFile(), which has none either.
    # ALWAYS prefixed - a missing session_id renders as 'unknown', never as the shared bare name.
    # Gating this on a non-empty id would drop both parallel hooks back onto one file, which is the
    # torn-append case this exists to remove. Twin of LogStream.writerFile(), which has no bare branch.
    _wp_pfx="$(wp_clean "${WP_SID:-unknown}")-$(wp_clean "${WP_AID:-coordinator}")-$BIN_NAME"
    _wp_f="$_wp_sd/${_wp_pfx}.log"
    # Rotate at the SAME 512 KB into the SAME .1.log sibling as every JS-side webpieces log. This runs
    # on every tool call, so it is one wc and no more; a size we cannot read counts as 0 (no rotation).
    _wp_sz="$(wc -c < "$_wp_f" 2>/dev/null | tr -d ' ')"
    case "$_wp_sz" in ''|*[!0-9]*) _wp_sz=0 ;; esac
    [ "$_wp_sz" -gt 524288 ] && mv -f "$_wp_f" "$_wp_sd/${_wp_pfx}.1.log" 2>/dev/null
    # shim= and bin= are the two facts this log could not previously answer, and they are the ones that
    # decide whether a tree was governed by its OWN release or a borrowed one:
    #   shim= WHICH COPY OF ai-hook.sh RAN — $ROOT, resolved from $0. The file is TRACKED, so every
    #         worktree carries the version at ITS commit; settings.json registers it ABSOLUTE, so the copy
    #         that runs is the SESSION ROOT's. Logged rather than assumed, on EVERY line: compared against
    #         tree= it is the STRADDLE detector (tree=agent-X shim=<repo> = standing in one tree, judged by
    #         another), and that pair varies constantly.
    #   bin=  WHICH TREE SUPPLIED THE BINARY — $BIN_ROOT, the upward walk's answer.
    #
    # bin= IS PRINTED ONLY WHEN IT DIFFERS FROM shim=, so its mere PRESENCE is the diagnostic ("the binary
    # came from a different tree than the shim") instead of ~50 bytes repeated on every line. Measured
    # across 549 logged lines: it differed on 39, every one a worktree agent's first few calls before it
    # ran pnpm install — after that they matched for the rest of that agent's life. And since the hooks
    # went ABSOLUTE, shim= is always the MAIN tree, so the two can now only differ when the main tree
    # itself has no node_modules (a fresh clone before install). ~7% of lines then, near 0% going forward.
    # A unit test asserts the field appears if and only if the roots differ, so it cannot quietly become
    # unconditional noise again.
    _wp_bin=""
    [ "$BIN_ROOT" != "$ROOT" ] && _wp_bin="bin=$BIN_ROOT$WP_TAB"
    # layer= and row= are the JOIN KEYS, and they are here so the join is REAL rather than promised.
    # Every L0 deny now opens '[<guard>] (layer=L0 fault=<code> row=<n>)' and cites "the same coordinates
    # the audit line carries" — which was true of the JS half (MATRIX_L0_BLOCK, via decision-log) and
    # FALSE of this one, which carried 'fault=' alone. Fixing the message instead of the line would have
    # left 'grep 'layer=L0 row=3'' finding one half of L0 and silently missing the other four faults.
    #
    # 'row=' is NOT a constant: it is the row of the three-row matrix this call actually took, read off
    # the verdict — hand-down, allowlisted, or blocked — exactly as L1 logs 'row=' from L1_ROWS. That is
    # what distinguishes it from the ~50 constant bytes 'bin=' used to spend above.
    _wp_row=1
    case "$2" in ALLOW*) _wp_row=2 ;; DENY*) _wp_row=3 ;; esac
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$BIN_NAME" "$TOOL" "ai=$AI" "tree=$WP_TREE" "layer=L0" "row=$_wp_row" "shim=$ROOT" "$_wp_bin" "fault=$1" "$2" "$CMD_LOG" >> "$_wp_f"
  } 2>/dev/null || true
}
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
    # THE HEALTHY CALL, which this log used to be silent about (see WP_LOG_SH's header). No sh-side
    # fault, the bin ran, and its own exit code says how it ended — 0 allow, 2 block. Logged AFTER the
    # decision bytes are already on stdout, so the audit trail never sits between the guard and Claude
    # Code. Without this line, "no entry" meant either healthy or never-ran, and those are the two
    # answers a reader most needs to tell apart.
    WP_VERDICT=PASS-BIN-ALLOW
    [ "$RC" = 2 ] && WP_VERDICT=PASS-BIN-BLOCK
    wp_log - "$WP_VERDICT"
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
# WHICH of the guards/L0-tooling.md faults fired, in the doc's own letters. Only the four sh-side
# codes can be decided here; S/C/Y live in the binary, which never got to run on this path.
WP_FAULT=X                                            # X — bin missing (fresh clone, new worktree)
[ -z "$WP_HOOK_PKG_DECLARED" ] && WP_FAULT=U          # U — X, but nothing declares the package: install is a no-op
[ -n "$DRIFT_PKG" ] && WP_FAULT=D                     # D — version drift; D and K are mutually exclusive
[ -n "$BROKEN_BIN" ] && WP_FAULT=K                    # K — bin present but CRASHED (corrupt node_modules)
DENY_LABEL="DENY"
[ -z "$WP_HOOK_PKG_DECLARED" ] && DENY_LABEL="DENY-UNDECLARED"  # nothing in package.json asks for the package
[ -n "$DRIFT_PKG" ] && DENY_LABEL="DENY-STALE"        # version drift, not a missing bin
[ -n "$BROKEN_BIN" ] && DENY_LABEL="DENY-BROKEN"      # bin present but CRASHED (corrupt node_modules)
# THE L0 ALLOWLIST, entry order identical to isAllowed(). No fault is consulted: a cure that cannot
# help a given fault also cannot hurt it, and gating each entry on a fault is what produced the four
# defects recorded above L0_ALLOW_ERE.
if [ "$TOOL" = "Read" ]; then
  wp_log "$WP_FAULT" ALLOW-READ   # you must be able to read to work out how to fix this
  exit 0
fi
case "$TOOL" in
  webrun|collaborationspawn_agent|collaborationwait_agent|view_image|update_plan)
    # Nothing to judge — the Codex tools that are neither a shell command nor a file edit. sh twin of
    # isAllowed()'s L0_IGNORED_TOOLS branch; see there for why the list is EXPLICIT and why apply_patch
    # (Codex's only WRITE) is not on it.
    wp_log "$WP_FAULT" ALLOW-IGNORED
    exit 0 ;;
esac
case "$FILE" in
  */webpieces.config.json|webpieces.config.json)
    wp_log "$WP_FAULT" ALLOW-CONFIG  # the always-allowed recovery target — every guard is configured from it
    exit 0 ;;
  */pnpm-workspace.yaml|pnpm-workspace.yaml|*/package.json|package.json)
    # A manifest AT THE ROOT OF A GOVERNED TREE, which is the only place the version pin lives. The test
    # is the sibling webpieces.config.json — TRACKED, so the main clone has one and every worktree has its
    # own — and NOT $ROOT, which names whichever tree supplied this shim and would deny the other's.
    # Basename alone would be far worse here than in the JS half: this arm is TERMINAL (exit 0, the bin
    # never runs), so every packages/**/package.json would be editable with nothing judging it.
    if [ -f "$(dirname -- "$FILE")/webpieces.config.json" ]; then
      wp_log "$WP_FAULT" ALLOW-MANIFEST  # raising the pin must be typable from inside the block
      exit 0
    fi ;;
esac
if printf '%s' "$CMD" | grep -Eq '^(cd[[:space:]]+([A-Za-z0-9._/@~+-]+|'\''[^'\'']+'\'')[[:space:]]*&&[[:space:]]*)?((pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*|rm[[:space:]]+-rf[[:space:]]+(\./)?node_modules/?([[:space:]]*&&[[:space:]]*(pnpm|npm)[[:space:]]+(install|i)([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*)?|git[[:space:]]+fetch([[:space:]]+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*|git[[:space:]]+checkout[[:space:]]+main[[:space:]]*&&[[:space:]]*git[[:space:]]+pull[[:space:]]+origin[[:space:]]+main|(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-upgrade-shim|cp[[:space:]]+(\./)?node_modules/@webpieces/ai-hook-rules/templates/ai-hook\.sh[[:space:]]+(\./)?\.claude/webpieces/ai-hook\.sh|(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-prune-unknown-config|(pnpm|npm|npx)([[:space:]]+(exec|run))?[[:space:]]+wp-install-ai-hooks([[:space:]]+--[A-Za-z][A-Za-z0-9=._/@:-]*)*|(pnpm|npm)[[:space:]]+add([[:space:]]+(-[A-Za-z]|--[A-Za-z][A-Za-z0-9=._/@:-]*))*[[:space:]]+@webpieces/ai-hook-rules(@[A-Za-z0-9._+-]+)?([[:space:]]+(-[A-Za-z]|--[A-Za-z][A-Za-z0-9=._/@:-]*))*|(pwd|git[[:space:]]+(status|log|diff|show|branch|rev-parse)|git[[:space:]]+worktree[[:space:]]+list)([[:space:]]+(--)?[A-Za-z0-9][A-Za-z0-9=._/@:-]*)*)([[:space:]]+2>(&1|/dev/null))?([[:space:]]*\|[[:space:]]*(tail|head)([[:space:]]+-(n[[:space:]]+)?[0-9]+)?)?[[:space:]]*$'; then
  wp_log "$WP_FAULT" ALLOW-CURE   # record the self-heal we let through (re-enables the guards)
  exit 0                     # allow the cure so the assistant can break the deadlock
fi
wp_log "$WP_FAULT" "$DENY_LABEL"  # every fail-closed block, with the fault that caused it
if [ -n "$BROKEN_BIN" ]; then
  # Report (do NOT auto-clean) the orphaned pnpm staging dirs — a package pnpm was mid-way through
  # writing is left behind as <name>_<pid>_<hash>. Their presence is the fingerprint of an install that
  # was killed, which is what corrupts node_modules in the first place. Best-effort; never fatal.
  STAGING_N="$(ls "$BIN_ROOT/node_modules" 2>/dev/null | grep -Ec '_[0-9a-f]+_[0-9a-f]+$' || true)"
  STAGING_NOTE=""
  if [ "${STAGING_N:-0}" -gt 0 ] 2>/dev/null; then
    STAGING_NOTE="${NL}    → also found $STAGING_N orphaned pnpm staging dirs (name_pid_hash) under node_modules - the fingerprint of an install that was killed mid-write."   # only when N > 0
  fi
  # The HEADLINE, kept in its own variable so DENY_EMIT_SH can paint ONLY it red (see there).
  WP_HEAD="❌ webpieces ai-hooks blocked this call: the webpieces guards are DOWN."
  REASON="$WP_HEAD${NL}${NL}[guard-bin-crashed] (layer=L0 fault=K row=3, 1 violation)${NL}  ${BIN_NAME} ($CRASH_MSG)${NL}    → it is installed but CRASHED, so your node_modules is corrupt or partially written; the guards cannot run and they must not be silently skipped. Every OTHER tool call is BLOCKED until they can.${STAGING_NOTE}${NL}    → matrix row 3: fault=K present / on the allowlist? no -> BLOCK. Those are the same coordinates the audit line carries (layer=L0 row=3 fault=K) and the same row webpieces.guard-matrix.md prints.${NL}${NL}${WP_STILL_ALLOWED}${NL}${NL}  Fix Option 1: (preferred) the only cure. A bare 'pnpm install' will NOT fix this, because pnpm sees the correct version on disk and skips the broken package${NL}    run EXACTLY: 'rm -rf node_modules && pnpm install'${NL}${NL}Run it EXACTLY as written - the allowlist matches the whole command, so appending anything (even && git status) makes it a different command and it is rejected; that is not the guard blocking its own cure. Only these may be added: a leading cd <dir> && (single-quote a path containing spaces), a trailing 2>&1, and | tail -N."
elif [ -n "$DRIFT_PKG" ]; then
  # DECIDE THE DIRECTION, do not make the reader do it (2026-08-03). The detection is a plain !=, so it
  # fires BOTH ways, and the message used to carry OPTION 1/2/3 covering every direction at once — 3343
  # chars of which only about a third was the decision. A reader on the wrong branch of that menu was
  # one misread away from a downgrade. So compare the two versions HERE and emit only the relevant half.
  #
  # WITH AWK, not `sort -V`: -V is a GNU extension (absent/different on BSD sort), while the shim
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
  DRIFT_DIR="$(awk -v i="$DRIFT_INSTALLED" -v d="$DRIFT_DECLARED" 'BEGIN {
    iv = i; sub(/\+.*/, "", iv); ic = iv; sub(/-.*/, "", ic); ip = substr(iv, length(ic) + 1)
    dv = d; sub(/\+.*/, "", dv); dc = dv; sub(/-.*/, "", dc); dp = substr(dv, length(dc) + 1)
    if (ic !~ /^[0-9]+(\.[0-9]+)*$/ || dc !~ /^[0-9]+(\.[0-9]+)*$/) exit
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
  if [ "$DRIFT_DIR" = older ]; then
    # The HEADLINE, kept in its own variable so DENY_EMIT_SH can paint ONLY it red (see there).
    WP_HEAD="❌ webpieces ai-hooks blocked this call: webpieces version drift."
    REASON="$WP_HEAD${NL}${NL}[version-drift] (layer=L0 fault=D row=3, 1 violation)${NL}  package.json pins $DRIFT_PKG@$DRIFT_DECLARED but node_modules has $DRIFT_INSTALLED${NL}    → node_modules is OLDER, so the pin is what you want. Every OTHER tool call is BLOCKED until the two agree.${NL}    → matrix row 3: fault=D present / on the allowlist? no -> BLOCK. Those are the same coordinates the audit line carries (layer=L0 row=3 fault=D) and the same row webpieces.guard-matrix.md prints.${NL}${NL}${WP_STILL_ALLOWED}${NL}${NL}  Fix Option 1: (preferred) the only cure - it makes node_modules match the pin${NL}    run EXACTLY: 'pnpm install'${NL}${NL}Run it EXACTLY as written - the allowlist matches the whole command, so appending anything (even && git status) makes it a different command and it is rejected; that is not the guard blocking its own cure. Only these may be added: a leading cd <dir> && (single-quote a path containing spaces), a trailing 2>&1, and | tail -N."
  else
    # NEWER, or undecidable — the same choices apply either way, so the only thing the ambiguous
    # case changes is the claim about which side is stale.
    DRIFT_NOTE="node_modules is NEWER, so the PIN is the stale side and a bare 'pnpm install' DOWNGRADES you to $DRIFT_DECLARED"
    [ "$DRIFT_DIR" = newer ] || DRIFT_NOTE="these two versions could not be ordered automatically - compare them yourself: if node_modules is the NEWER side then the PIN is the stale side and a bare 'pnpm install' DOWNGRADES you to $DRIFT_DECLARED"
    WP_BRANCH="$(git -C "$ROOT" branch --show-current 2>/dev/null)"
    WP_PIN_EDIT="edit $ROOT/pnpm-workspace.yaml - the catalog line for $DRIFT_PKG, or that dependency in $ROOT/package.json if this repo pins directly - and set it to $DRIFT_INSTALLED, then run 'pnpm install'"
    if [ -z "$WP_BRANCH" ]; then
      WP_FIX="  Fix Option 1: (preferred) HEAD is DETACHED here, so a pin edit would belong to no branch - get onto main instead, whose pin is already at or ahead of what is installed, so the drift clears with no edit at all${NL}    run EXACTLY: 'git checkout main && git pull origin main', then 'pnpm install'${NL}  Fix Option 2: you mean to stay on this exact commit - the downgrade to $DRIFT_DECLARED is the point${NL}    run EXACTLY: 'pnpm install'"
    elif [ "$WP_BRANCH" = main ]; then
      WP_FIX="  Fix Option 1: (preferred) go FORWARD - keep what is installed and raise the pin to match it${NL}    ${WP_PIN_EDIT}${NL}    That edit is ALLOWED while this block is up, and the install then only rewrites the lock - nothing is downgraded, because the pin now names what is already on disk.${NL}  Fix Option 2: you are on main and want what origin pins instead${NL}    run EXACTLY: 'git checkout main && git pull origin main', then 'pnpm install'"
    else
      WP_FIX="  Fix Option 1: (preferred) go FORWARD - keep what is installed and raise THIS branch's pin to match it${NL}    ${WP_PIN_EDIT}${NL}    That edit is ALLOWED while this block is up, and the install then only rewrites the lock - nothing is downgraded, because the pin now names what is already on disk.${NL}  Fix Option 2: you mean to align node_modules to YOUR branch pin - that is a DOWNGRADE to $DRIFT_DECLARED, so pick it only if you meant to${NL}    run EXACTLY: 'pnpm install'${NL}    Do NOT reach for 'git pull origin main': pulling main into a feature branch destroys the fork point the build gate --base and the PR review diff are computed from, and the guards block it."
    fi
    # The HEADLINE, kept in its own variable so DENY_EMIT_SH can paint ONLY it red (see there).
    WP_HEAD="❌ webpieces ai-hooks blocked this call: webpieces version drift."
    REASON="$WP_HEAD${NL}${NL}[version-drift] (layer=L0 fault=D row=3, 1 violation)${NL}  package.json pins $DRIFT_PKG@$DRIFT_DECLARED but node_modules has $DRIFT_INSTALLED${NL}    → $DRIFT_NOTE. That may be exactly what you want. Every OTHER tool call is BLOCKED until the two agree.${NL}    → matrix row 3: fault=D present / on the allowlist? no -> BLOCK. Those are the same coordinates the audit line carries (layer=L0 row=3 fault=D) and the same row webpieces.guard-matrix.md prints.${NL}${NL}${WP_STILL_ALLOWED}${NL}${NL}${WP_FIX}${NL}${NL}Run it EXACTLY as written - the allowlist matches the whole command, so appending anything (even && git status) makes it a different command and it is rejected; that is not the guard blocking its own cure. Only these may be added: a leading cd <dir> && (single-quote a path containing spaces), a trailing 2>&1, and | tail -N."
  fi
else
  # A LINKED WORKTREE is the overwhelmingly common way to land here with a perfectly healthy repo:
  # git gives the new worktree a .git FILE (the primary clone has a .git directory) and copies no
  # node_modules, so the very first tool call in a brand-new worktree fail-closes on a missing bin.
  # Naming that explicitly turns a baffling "not installed" into a one-command fix, and the HERE is
  # load-bearing: installing in the primary clone does nothing for this tree.
  WORKTREE_NOTE=""
  if [ -f "$ROOT/.git" ]; then
    WORKTREE_NOTE="${NL}    → $ROOT is a LINKED WORKTREE - git does not copy node_modules into a new worktree, so this is expected on a fresh one. Run the Fix Option HERE, in this worktree, not in the primary clone."
  fi
  if [ -z "$WP_HOOK_PKG_DECLARED" ]; then
    # FAULT U — the one shape where the X message is not merely unhelpful but actively WRONG. It asserted
    # "declared in package.json" without ever checking, and prescribed the one command that provably
    # cannot help: with nothing asking for the package, `pnpm install` reports "Lockfile is up to date"
    # and converges to the identical broken tree, forever. So say what is actually true, say out loud
    # that the install is a no-op (an agent that has already run it needs to be told to STOP), and
    # prescribe the add — which is allowlist entry ADD_HOOK_PKG, so it is reachable while this block is up.
    WP_ADD_CMD="pnpm add -D @webpieces/ai-hook-rules"
    [ -n "$WP_PIN" ] && WP_ADD_CMD="${WP_ADD_CMD}@$WP_PIN"
    # The HEADLINE, kept in its own variable so DENY_EMIT_SH can paint ONLY it red (see there).
    WP_HEAD="❌ webpieces ai-hooks blocked this call: the guard package is not declared anywhere."
    REASON="$WP_HEAD${NL}${NL}[guard-pkg-undeclared] (layer=L0 fault=U row=3, 1 violation)${NL}  @webpieces/ai-hook-rules is NOT declared in package.json anywhere, and is not installed (${BIN_NAME} not found)${NL}    → .claude/settings.json still runs its hooks, so every OTHER tool call is BLOCKED. Do NOT run 'pnpm install': nothing asks for this package, so it is a NO-OP and repeating it converges to this same state.${NL}    → matrix row 3: fault=U present / on the allowlist? no -> BLOCK. Those are the same coordinates the audit line carries (layer=L0 row=3 fault=U) and the same row webpieces.guard-matrix.md prints.${NL}${NL}${WP_STILL_ALLOWED}${NL}${NL}  Fix Option 1: (preferred) declare it directly, to unblock yourself right now${NL}    run EXACTLY: '$WP_ADD_CMD'${NL}  Fix Option 2: the durable fix - @webpieces/ai-hook-rules normally arrives with @webpieces/nx-webpieces-rules, the umbrella that bundles the whole toolchain, so upgrade that once you are unblocked.${NL}  NOT an option: if you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json instead.${NL}${NL}Run it EXACTLY as written - the allowlist matches the whole command, so appending anything (even && git status) makes it a different command and it is rejected; that is not the guard blocking its own cure. Only these may be added: a leading cd <dir> && (single-quote a path containing spaces), a trailing 2>&1, and | tail -N."
  else
    # The HEADLINE, kept in its own variable so DENY_EMIT_SH can paint ONLY it red (see there).
    WP_HEAD="❌ webpieces ai-hooks blocked this call: the webpieces guard bin is not installed."
    REASON="$WP_HEAD${NL}${NL}[guard-bin-missing] (layer=L0 fault=X row=3, 1 violation)${NL}  @webpieces/ai-hook-rules is declared in package.json but is not installed (${BIN_NAME} not found)${NL}    → the guards cannot run, so every OTHER tool call is BLOCKED until they can.${WORKTREE_NOTE}${NL}    → matrix row 3: fault=X present / on the allowlist? no -> BLOCK. Those are the same coordinates the audit line carries (layer=L0 row=3 fault=X) and the same row webpieces.guard-matrix.md prints.${NL}${NL}${WP_STILL_ALLOWED}${NL}${NL}  Fix Option 1: (preferred) the only cure - it materializes what package.json already asks for${NL}    run EXACTLY: 'pnpm install'${NL}  NOT an option: if you removed @webpieces/ai-hook-rules on purpose, delete its hooks from .claude/settings.json instead.${NL}${NL}Run it EXACTLY as written - the allowlist matches the whole command, so appending anything (even && git status) makes it a different command and it is rejected; that is not the guard blocking its own cure. Only these may be added: a leading cd <dir> && (single-quote a path containing spaces), a trailing 2>&1, and | tail -N."
  fi
fi
if [ "$TOOL" = "Bash" ]; then
  printf '{"systemMessage":"%s🛑 %s%s%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "${ESC}[31;1m" "$WP_HEAD" "${ESC}[0m" "${REASON#"$WP_HEAD"}" "$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$REASON"
fi
exit 0                       # decision is carried by permissionDecision "deny", not the exit code
