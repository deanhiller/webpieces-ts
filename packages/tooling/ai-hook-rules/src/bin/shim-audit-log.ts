import { LOGS_STATE_DIR, WORKTREE_STATE_DIR, WEBPIECES_TMP_DIR } from '@webpieces/rules-config';
import { L0_SHIM_STREAM } from '../core/log-streams';
import { AI_TYPES } from '../core/agent-event';

import {
    L0_FAULT_NONE, L0_LAYER, L0_SH_FAULT_CODES, L0_ROW_ALLOWLISTED, L0_ROW_BLOCKED, L0_ROW_HANDED_DOWN,
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
 * One verdict label the shim can record, WITH what it means. Data-only → a class, per CLAUDE.md.
 *
 * The meaning travels with the label because guards/L0-tooling.md renders this table rather than
 * restating it: a bare `string[]` left the meanings in prose, and the prose is what went stale (the
 * hand-written doc documented `DENY-UNDECLARED` for releases while this array did not list it at all).
 */
export class ShimLogVerdict {
    constructor(
        readonly label: string,
        readonly means: string,
    ) {}
}

/**
 * The verdict vocabulary one shim invocation can record, and how each maps to guards/L0-tooling.md.
 *
 * The ALLOW-* and DENY-* labels are the ones this log has always used and are kept verbatim, so
 * anything already grepping them keeps working. `PASS-BIN-*` is the healthy case the log used to be
 * silent about, and `DENY-UNDECLARED` is fault U's — emitted by the shim since U existed, but missing
 * from this array until the generated doc started reading it.
 */
export const SHIM_LOG_VERDICTS: readonly ShimLogVerdict[] = [
    new ShimLogVerdict('PASS-BIN-ALLOW', 'no sh-side fault; the bin ran and exited 0 — matrix row 1, handed down to L1'),
    new ShimLogVerdict('PASS-BIN-BLOCK', 'no sh-side fault; the bin ran and exited 2 — matrix row 1, a LATER layer blocked'),
    new ShimLogVerdict('ALLOW-READ', 'allowlist entry 1 (any Read) — PASS, but terminal here (the bin never ran)'),
    new ShimLogVerdict('ALLOW-IGNORED', 'a Codex tool with nothing to judge (L0_IGNORED_TOOLS) — PASS, terminal here'),
    new ShimLogVerdict('ALLOW-CODEX-READ',
        'the harness-gated entry: a read-shaped Bash command on CODEX, which has no Read tool — PASS, terminal here. '
        + 'It cannot appear on a claude-code line; if one ever does, the sh harness test (AI_TYPE_SH) misread the payload'),
    new ShimLogVerdict('ALLOW-CONFIG', 'allowlist entry 2 (a Write/Edit of webpieces.config.json) — PASS, terminal here'),
    new ShimLogVerdict('ALLOW-MANIFEST', 'allowlist entry 3 (a Write/Edit of pnpm-workspace.yaml or package.json) — PASS, terminal here'),
    new ShimLogVerdict('ALLOW-CURE', 'a Bash entry of the allowlist matched — ALLOW'),
    new ShimLogVerdict('DENY', 'fault X, not on the allowlist — BLOCK_AI_CURE'),
    new ShimLogVerdict('DENY-UNDECLARED', 'fault U, not on the allowlist — BLOCK_AI_CURE'),
    new ShimLogVerdict('DENY-STALE', 'fault D, not on the allowlist — BLOCK_AI_CURE'),
    new ShimLogVerdict('DENY-BROKEN', 'fault K, not on the allowlist — BLOCK_AI_CURE'),
];

/**
 * The sh-side L0 fault codes, IMPORTED from the one codebook (../core/l0-fault-codes) rather than
 * retyped here — the letters in this file and the letters in `L0_FAULTS` have to be the same letters or
 * the log cannot be reconciled against the matrix. `-` means "no sh-side fault": the shim cannot
 * classify S / C / Y, which the BINARY detects and stamps onto its OWN streams with the same `fault=`
 * field, so a `-` here is a statement about this layer only, never a claim that nothing was wrong.
 */
export const SHIM_LOG_FAULTS = [...L0_SH_FAULT_CODES, L0_FAULT_NONE] as const;

/**
 * One FIELD of the audit line: how it reads on disk, the sh expression that produces it, and what it
 * answers. Data-only → a class, per CLAUDE.md.
 */
export class ShimLogField {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        readonly label: string,
        /** The sh word spliced into the printf below — the ONE place this field's value is spelled. */
        readonly shValue: string,
        readonly means: string,
        /**
         * True for a field that is printed only SOMETIMES (`bin=`, and only when it differs from
         * `shim=`). Such a field carries its OWN trailing tab in its sh value and therefore renders
         * with NO separator of its own — `%s%s` glues it to the next field, so an empty value leaves
         * the line one field shorter rather than leaving a stray tab behind.
         */
        readonly optional: boolean = false,
    ) {}
}

/**
 * THE LINE, as data. The printf below is BUILT from this array and guards/L0-tooling.md RENDERS it, so
 * a field cannot be added, dropped or reordered without both the shim and the doc changing with it.
 *
 * That is not decoration: `shim=`/`bin=` were inserted mid-line (deliberately breaking positional
 * readers rather than appending where a stale parser keeps working), then `layer=`/`row=` joined them,
 * and the hand-written doc went on describing a 7-field line with no `U` in its fault set the whole time.
 */
export const SHIM_LOG_FIELDS: readonly ShimLogField[] = [
    new ShimLogField('<iso-ts>', `"$(date '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null)"`,
        'when the shim judged the call, local time with offset'),
    new ShimLogField('<bin-name>', '"$BIN_NAME"',
        'WHICH hook ran - wp-ai-guards-hook or wp-ai-rules-hook; Claude Code runs them in parallel'),
    new ShimLogField('<tool>', '"$TOOL"', 'the PreToolUse tool name (Bash, Read, Write, Edit, apply_patch, …)'),
    // WHICH HARNESS. Inserted MID-LINE rather than appended, which is this format's house style and is
    // deliberate: a positional reader that has not been updated fails loudly here instead of silently
    // reading the wrong column forever (see this array's own header). The values are the `AiType`
    // union's, produced by AI_TYPE_SH — one vocabulary across all five streams. A row written before
    // this field existed simply has no `ai=`, which reads as `unknown`; that is a real value, not a
    // compatibility shim.
    new ShimLogField(`ai=<${AI_TYPES.join('|')}>`, '"ai=$AI"',
        'WHICH coding agent made the call, from the one turn_id discriminator (adapters/detect-ai.ts)'),
    new ShimLogField('tree=<name|primary>', '"tree=$WP_TREE"',
        'git\'s own name for the worktree the CALL was made in, derived from the payload\'s cwd'),
    new ShimLogField(`layer=${L0_LAYER}`, `"layer=${L0_LAYER}"`,
        'the layer that judged it — constant here, and the first half of the join key a deny cites'),
    new ShimLogField(`row=<${L0_ROW_HANDED_DOWN}|${L0_ROW_ALLOWLISTED}|${L0_ROW_BLOCKED}>`, '"row=$_wp_row"',
        'WHICH row of the three-row matrix this call took, read off the verdict (hand-down / allowlisted / blocked)'),
    new ShimLogField('shim=<root>', '"shim=$ROOT"',
        'WHICH COPY of ai-hook.sh ran, resolved from $0 — against tree= it is the straddle detector'),
    new ShimLogField('bin=<root>', '"$_wp_bin"',
        'WHICH TREE supplied the binary — printed ONLY when it differs from shim=, so its presence IS the borrow',
        true),
    new ShimLogField(`fault=<${SHIM_LOG_FAULTS.join('|')}>`, '"fault=$1"',
        'the sh-side L0 fault, or `-`; S/C/Y are the binary\'s and are stamped on ITS streams'),
    new ShimLogField('<VERDICT>', '"$2"', 'one of the verdict labels below — kept adjacent to the command'),
    new ShimLogField('<command>', '"$CMD_LOG"',
        'the command PREFIX (the audit spelling; the DECISION reads $CMD, which fails closed on a quote)'),
];

/**
 * The writer's `printf`, assembled from SHIM_LOG_FIELDS — one `%s` per field, in the same order, and a
 * tab after every field EXCEPT an optional one (which carries its own). Retyping either half is what
 * let the format and its documentation disagree, so neither half is retyped anywhere.
 */
export const SHIM_LOG_PRINTF =
    `printf '${SHIM_LOG_FIELDS.map(
        (f: ShimLogField, i: number): string => '%s' + (i === SHIM_LOG_FIELDS.length - 1 ? '' : (f.optional ? '' : '\\t')),
    ).join('')}\\n' `
    + `${SHIM_LOG_FIELDS.map((f: ShimLogField): string => f.shValue).join(' ')} >> "$_wp_f"`;

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
    WP_TREE=primary; WP_LOG_DIR="$WP_CWD/${WEBPIECES_TMP_DIR}/${LOGS_STATE_DIR}"
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
    */.git) [ -d "\${_wp_cd%/*}" ] && _wp_primary="\${_wp_cd%/*}" ;;
  esac
  # The PRIMARY clone's log dir, resolved on both branches. A deny that has to tell a human WHERE the
  # audit trail is (the inverse-drift escalation in shim.ts) must be able to name both the tree it is
  # standing in and the primary — a subagent has no reach into the second one, so the deny has to quote
  # that path rather than send anyone to go and look.
  WP_PRIMARY_LOG_DIR="$_wp_primary/${WEBPIECES_TMP_DIR}/${LOGS_STATE_DIR}"
  if [ "$_wp_gd" = "$_wp_cd" ]; then
    WP_TREE=primary
    WP_LOG_DIR="$WP_PRIMARY_LOG_DIR"
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
 * FORMAT: SHIM_LOG_FIELDS, tab-separated, append-only — that array IS the format, and SHIM_LOG_PRINTF
 * is built from it, so neither this docblock nor guards/L0-tooling.md can describe a line the shim does
 * not write.
 *
 * `tree=` and `fault=` are the two fields that make the file reconcilable against guards/L0-tooling.md:
 * the first says WHICH checkout produced the line (a shared log across seven worktrees is otherwise
 * unreadable), the second says which of the sh-side faults the shim detected. The verdict
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
WP_PRIMARY_LOG_DIR=""
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
    ${SHIM_LOG_PRINTF}
  } 2>/dev/null || true
}`;
