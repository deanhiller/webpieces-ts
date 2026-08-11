import { LOGS_STATE_DIR, WORKTREE_STATE_DIR, WEBPIECES_TMP_DIR } from '@webpieces/rules-config';
import { L0_SHIM_STREAM } from '../core/log-streams';

import {
    L0_FAULT_NONE, L0_SH_FAULT_CODES, L0_ROW_ALLOWLISTED, L0_ROW_BLOCKED, L0_ROW_HANDED_DOWN,
} from '../core/l0-fault-codes';

// ---------------------------------------------------------------------------
// THE L0 AUDIT LOG, in POSIX sh — the shim half of
// `.webpieces/**/logs/L0-shim/<session>-<agent|coordinator>-<binName>.log`. The writer key is
// the sh twin of ai-hook-rules' LogStream.writerFile(): wp-ai-guards-hook and wp-ai-rules-hook are run
// IN PARALLEL by Claude Code on every file edit, so an unsplit name means two writers, one file, and
// torn appends above PIPE_BUF. A payload with no session_id renders 'unknown', never a bare name —
// there is no un-prefixed spelling on either side.
//
// Split out of ./shim.ts (which renders the shim body) purely so both stay readable; shim.ts splices
// these fragments in verbatim and re-exports the constants. Like l0-allowlist.ts, this module must
// stay dependency-light: the shim it renders has to work on a tree too broken to load the rule engine.
//
// ─── What changed, and why it is not just a bigger log ─────────────────────────────────────────────
// This log used to be a FAULT log wearing an audit log's name. `wp_log` fired only on the fail-closed
// path (ALLOW-READ / ALLOW-CONFIG / ALLOW-CURE / DENY*), so a HEALTHY call — the overwhelming majority
// — exec'd the bin and recorded nothing at all. You could therefore never answer "what did L0 do to
// this tool call?", only "what did L0 do on the calls where L0 was already broken". Absence of a line
// meant either "healthy" or "the shim never ran", and those are the two answers you most need to tell
// apart. Every path now logs exactly one line, including the pass-through, so the file can be diffed
// against the documented matrix in guards/L0-tooling.md rather than merely spot-checked.
//
// Two more defects went with it:
//   • it wrote to a hardcoded `$ROOT/.webpieces/logs`, so every worktree's lines landed in one flat
//     file (or, worse, in whichever tree happened to hold the shim) instead of the per-tree namespace
//     the L1 binary has used since the state-dir split;
//   • it had NO rotation, on a file now written on EVERY tool call.
// ---------------------------------------------------------------------------

/**
 * Rotation threshold, in bytes — 512 KB, the SAME number and the same `.1.log` naming as
 * decision-log.ts / rejection-log.ts / main-sync-log.ts. Deliberately identical rather than merely
 * similar: two log families in one directory with two different retention rules is a trap for whoever
 * later tries to reason about how much history they still have.
 */
export const SHIM_LOG_MAX_BYTES = 512 * 1024;

/**
 * The verdict vocabulary one shim invocation can record, and how each maps to guards/L0-tooling.md.
 *
 * The three ALLOW-* and three DENY-* labels are the ones this log has always used and are kept
 * verbatim, so anything already grepping them keeps working. `PASS-BIN-*` is new: it is the healthy
 * case the log used to be silent about.
 *
 *   PASS-BIN-ALLOW  no sh-side fault; the bin ran and returned 0  → matrix row 1 (no fault → L1)
 *   PASS-BIN-BLOCK  no sh-side fault; the bin ran and returned 2  → matrix row 1; a LATER layer blocked
 *   ALLOW-READ      allowlist entry 1 (any Read)                  → PASS, terminal here (use case 10)
 *   ALLOW-CONFIG    allowlist entry 2 (webpieces.config.json)     → PASS, terminal here
 *   ALLOW-CURE      allowlist entries 3-8 (a cure command)        → ALLOW
 *   DENY            fault X, not on the allowlist                 → BLOCK_AI_CURE
 *   DENY-STALE      fault D, not on the allowlist                 → BLOCK_AI_CURE
 *   DENY-BROKEN     fault K, not on the allowlist                 → BLOCK_AI_CURE
 */
export const SHIM_LOG_VERDICTS = [
    'PASS-BIN-ALLOW', 'PASS-BIN-BLOCK', 'ALLOW-READ', 'ALLOW-CONFIG', 'ALLOW-CURE',
    'DENY', 'DENY-STALE', 'DENY-BROKEN',
] as const;

/**
 * The sh-side L0 fault codes, IMPORTED from the one codebook (../core/l0-fault-codes) rather than
 * retyped here — the letters in this file and the letters in `L0_FAULTS` have to be the same letters or
 * the log cannot be reconciled against the matrix. `-` means "no sh-side fault": the shim cannot
 * classify S / C / Y, which the BINARY detects and stamps onto its OWN streams with the same `fault=`
 * field, so a `-` here is a statement about this layer only, never a claim that nothing was wrong.
 */
export const SHIM_LOG_FAULTS = [...L0_SH_FAULT_CODES, L0_FAULT_NONE] as const;

/**
 * Shell fragment: derive WHERE this call's log belongs — the sh TWIN of `DotWebpieces.local()` +
 * `worktreeName()` + `primaryRoot()` in @webpieces/rules-config.
 *
 * sh cannot import TypeScript, so this derivation is duplicated by necessity; the mitigation is
 * `shim-audit-log.spec.ts`, which runs THIS function through a real /bin/sh in real git worktrees and
 * asserts it returns exactly what `dotWebpieces.worktreeName()` returns. If the two ever disagree the
 * lock goes red rather than the logs quietly splitting in half.
 *
 * It asks git the SAME question the TS side asks — `--git-dir` vs `--git-common-dir`, which differ if
 * and only if this is a linked worktree — but in ONE `rev-parse` (it accepts both flags and prints a
 * line each) rather than two, because this runs on the blocking path of every tool call.
 *
 * The tree is derived from the PAYLOAD's `cwd` (Claude Code documents it as the working directory the
 * hook was invoked from), not from `$ROOT`. `$ROOT` is where the shim FILE lives and stays the anchor
 * for what the drift guard MEASURES — this fragment changes only where the log is WRITTEN.
 *
 * Fails soft, exactly like the TS side: when git cannot answer, the log collapses to
 * `<cwd>/.webpieces/logs`, which is the pre-change behaviour.
 */
export const RESOLVE_LOG_DIR_SH = `wp_resolve_log_dir() {
  _wp_rp="$(git -C "$WP_CWD" rev-parse --git-dir --git-common-dir 2>/dev/null)"
  _wp_gd="$(printf '%s\\n' "$_wp_rp" | sed -n 1p)"
  _wp_cd="$(printf '%s\\n' "$_wp_rp" | sed -n 2p)"
  if [ -z "$_wp_gd" ] || [ -z "$_wp_cd" ]; then
    WP_TREE=primary; WP_LOG_DIR="$WP_CWD/${WEBPIECES_TMP_DIR}/${LOGS_STATE_DIR}"; return 0
  fi
  # git prints a BARE .git from the primary clone and an absolute path from a linked worktree; the TS
  # twin runs path.resolve(cwd, printed), so do the same before comparing or taking a basename.
  case "$_wp_gd" in /*) : ;; *) _wp_gd="$WP_CWD/$_wp_gd" ;; esac
  case "$_wp_cd" in /*) : ;; *) _wp_cd="$WP_CWD/$_wp_cd" ;; esac
  # The primary clone's root is the parent of the SHARED git dir — declining any layout whose shared
  # dir is not named .git (a bare repo, --separate-git-dir), same test as primaryRoot().
  _wp_primary="$WP_CWD"
  case "$_wp_cd" in
    */.git) [ -d "\${_wp_cd%/*}" ] && _wp_primary="\${_wp_cd%/*}" ;;
  esac
  if [ "$_wp_gd" = "$_wp_cd" ]; then
    WP_TREE=primary
    WP_LOG_DIR="$_wp_primary/${WEBPIECES_TMP_DIR}/${LOGS_STATE_DIR}"
  else
    # git's OWN name for the worktree (the basename of <primary>/.git/worktrees/<name>), not the
    # directory's basename — two worktrees under different parents may share a directory name.
    WP_TREE="\${_wp_gd##*/}"
    WP_LOG_DIR="$_wp_primary/${WEBPIECES_TMP_DIR}/${WORKTREE_STATE_DIR}/$WP_TREE/${LOGS_STATE_DIR}"
  fi
}`;

/**
 * Shell fragment: the audit-log writer itself — `wp_log <fault> <verdict>`, one tab-separated line.
 *
 * FORMAT (10 fields, tab-separated, append-only; 11 with the optional `bin=`):
 *   <iso-ts>  <bin-name>  <tool>  tree=<name|primary>  layer=L0  row=<1|2|3>  shim=<root>
 *   [bin=<root>]  fault=<D|X|U|K|->  <VERDICT>  <command>
 *
 * `tree=` and `fault=` are the two fields that make the file reconcilable against guards/L0-tooling.md:
 * the first says WHICH checkout produced the line (a shared log across seven worktrees is otherwise
 * unreadable), the second says which of the six documented faults the sh half detected. The verdict
 * keeps its historical spelling and stays adjacent to the command, so `grep 'DENY-STALE\\t'` still
 * finds what it always found.
 *
 * NEVER breaks or blocks the hook: the whole body is wrapped so a failure of any kind — unwritable
 * directory, read-only filesystem, missing `git` — is swallowed, and nothing is ever written to
 * stdout (stdout is the PreToolUse decision channel; a stray byte there corrupts allow/deny).
 *
 * The log dir is resolved LAZILY on first use so a call that never logs never pays for the git probe.
 */
export const WP_LOG_SH = `WP_TREE=""
WP_LOG_DIR=""
WP_TAB="$(printf '\\t')"     # one real tab, so the OPTIONAL bin= field can carry its own separator
${RESOLVE_LOG_DIR_SH}
wp_clean() {                 # one path segment from an UNTRUSTED payload id — twin of LogStream's segment()
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_' | sed -e 's/\\.\\{2,\\}/_/g' -e 's/^\\.\\{1,\\}/_/' | cut -c1-64
}
wp_log() {                   # $1 = L0 fault code (D|X|K|-), $2 = verdict label
  {
    [ -n "$WP_LOG_DIR" ] || wp_resolve_log_dir
    # The LAYER is the directory and the WRITER is the file — same layout the TS writers use, spelled
    # from the same constant so the two halves cannot drift apart.
    _wp_sd="$WP_LOG_DIR/${L0_SHIM_STREAM}"
    mkdir -p "$_wp_sd" 2>/dev/null || return 0
    # Same writer key as LogStream.writerFile(): <session>-<agent|coordinator>-<hook>.log. $BIN_NAME
    # IS the hook discriminator here (wp-ai-guards-hook vs wp-ai-rules-hook), and Claude Code runs those
    # two IN PARALLEL on every file edit — without this prefix they append to ONE file and tear above
    # PIPE_BUF. An empty session id renders 'unknown' — this has no bare-name branch, matching
    # LogStream.writerFile(), which has none either.
    # ALWAYS prefixed - a missing session_id renders as 'unknown', never as the shared bare name.
    # Gating this on a non-empty id would drop both parallel hooks back onto one file, which is the
    # torn-append case this exists to remove. Twin of LogStream.writerFile(), which has no bare branch.
    _wp_pfx="$(wp_clean "\${WP_SID:-unknown}")-$(wp_clean "\${WP_AID:-coordinator}")-$BIN_NAME"
    _wp_f="$_wp_sd/\${_wp_pfx}.log"
    # Rotate at the SAME 512 KB into the SAME .1.log sibling as every JS-side webpieces log. This runs
    # on every tool call, so it is one wc and no more; a size we cannot read counts as 0 (no rotation).
    _wp_sz="$(wc -c < "$_wp_f" 2>/dev/null | tr -d ' ')"
    case "$_wp_sz" in ''|*[!0-9]*) _wp_sz=0 ;; esac
    [ "$_wp_sz" -gt ${String(SHIM_LOG_MAX_BYTES)} ] && mv -f "$_wp_f" "$_wp_sd/\${_wp_pfx}.1.log" 2>/dev/null
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
    _wp_row=${L0_ROW_HANDED_DOWN}
    case "$2" in ALLOW*) _wp_row=${L0_ROW_ALLOWLISTED} ;; DENY*) _wp_row=${L0_ROW_BLOCKED} ;; esac
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s%s\\t%s\\t%s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)" "$BIN_NAME" "$TOOL" "tree=$WP_TREE" "layer=L0" "row=$_wp_row" "shim=$ROOT" "$_wp_bin" "fault=$1" "$2" "$CMD_LOG" >> "$_wp_f"
  } 2>/dev/null || true
}`;
