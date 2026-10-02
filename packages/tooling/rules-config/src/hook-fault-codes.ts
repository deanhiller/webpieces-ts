// ---------------------------------------------------------------------------
// THE L0 FAULT CODEBOOK — one letter per fault, declared HERE and nowhere else.
//
// Both halves of L0 stamp `fault=<code>` onto their audit lines: the POSIX `sh` shim writes D/X/U/K
// (shim-audit-log.ts), and the guard bin writes S/C/Y in JS (decision-log.ts, via runner.ts and
// hook-core.ts). The whole value of that field is that ONE grep — `grep 'fault=S'` — spans the entire
// trail, and that the faults actually observed can be diffed against `L0_FAULTS`. Both properties hold
// only while every emitter spells the letters the SAME way, and a hand-retyped 'S' in one emitter is
// exactly the drift this module exists to make impossible.
//
// It used to be retyped: the shim assigned `WP_FAULT=X` as a literal, SHIM_LOG_FAULTS listed the four
// sh-side letters again, and L0_FAULTS listed all seven a third time. Three spellings of one
// vocabulary, held together by a unit test that could only notice AFTER they diverged.
//
// This module is a LEAF — no imports at all — on purpose. `l0-matrix.ts` (core) builds `L0_FAULTS`
// from these constants and `shim-audit-log.ts` / `shim.ts` (bin) render them into the shim; parking the
// constants in either of those two would make the other one a core↔bin import cycle. It also keeps the
// shim renderer dependency-light, which it must be: it has to work on a tree too broken to load the
// rule engine.
// ---------------------------------------------------------------------------

/** `D` — version drift: the root package.json pin != the installed version. Decided in `sh`. */
export const L0_FAULT_DRIFT = 'D';

/** `X` — the guard bin is missing (fresh clone, new worktree, package removed). Decided in `sh`. */
export const L0_FAULT_BIN_MISSING = 'X';

/** `U` — the bin is missing AND nothing declares the package, so an install is a no-op. `sh`. */
export const L0_FAULT_UNDECLARED = 'U';

/** `K` — the bin is present but CRASHED (corrupt node_modules). Decided in `sh`. */
export const L0_FAULT_BIN_BROKEN = 'K';

/** `S` — the committed `.claude/webpieces/ai-hook.sh` != `renderShim()`. Decided in the bin, in JS. */
export const L0_FAULT_SHIM_STALE = 'S';

/** `C` — `webpieces.config.json` is missing. Decided in the bin, in JS. */
export const L0_FAULT_CONFIG_MISSING = 'C';

/** `Y` — a loaded rule has no `webpieces.config.json` key. Decided in the bin, in JS. */
export const L0_FAULT_CONFIG_OUT_OF_SYNC = 'Y';

/**
 * No fault AT THIS LAYER — the value every audit line carries when nothing fired.
 *
 * Never a claim that nothing was wrong: a `fault=-` line from the `sh` shim only says the sh half found
 * nothing, and the bin it then exec'd may still have blocked on S/C/Y and stamped its own line.
 */
export const L0_FAULT_NONE = '-';

/**
 * The faults decided in POSIX `sh`, BEFORE the bin runs — a stale, missing or broken validator cannot
 * be trusted to validate itself. In first-match-wins order.
 */
export const L0_SH_FAULT_CODES = [
    L0_FAULT_DRIFT, L0_FAULT_BIN_MISSING, L0_FAULT_UNDECLARED, L0_FAULT_BIN_BROKEN,
] as const;

/**
 * The faults decided INSIDE the guard bin, in JS. These reached the audit trail with no fault label at
 * all until the JS emitters started stamping them: an `S` storm that blocked an agent for ~20 tool
 * calls left two lines in the `rejections/` stream, both attributed to a downstream rule, and nothing
 * anywhere identifying L0.
 */
export const L0_JS_FAULT_CODES = [
    L0_FAULT_SHIM_STALE, L0_FAULT_CONFIG_MISSING, L0_FAULT_CONFIG_OUT_OF_SYNC,
] as const;

// ---------------------------------------------------------------------------
// THE JOIN KEYS — the three artifacts that describe one L0 event, and the coordinates that line them up.
//
// There are three, and until now they could not be grepped together:
//   1. THE DENY the agent reads in the moment (shim-deny-reason.ts for S; DENY_REASON_SH for D/X/U/K)
//   2. THE AUDIT LINE (`.webpieces/logs/**`), which carries `layer=` `row=` `fault=`
//   3. THE MATRIX DOC (webpieces.guard-matrix.md, rendered from L0_FAULTS + L0_ALLOWLIST)
//
// The deny had NONE of them: no fault letter, no row, and — the highest-value omission — no guard NAME,
// while every L1/L2 deny opens `[<rule-name>] (N violations)`. So a transcript could not be debugged
// against the log after the fact, and a reader could not find the matrix row by eye.
//
// These constants are that vocabulary, declared HERE for the same reason the letters are: this module is
// a LEAF with no imports, so `core/l0-matrix.ts` (the doc), `bin/shim*.ts` (the denies) and
// `core/decision-log.ts` (the log) can all reach it without an import cycle. Retyping a name in any one
// of them is the drift this file exists to make impossible.
// ---------------------------------------------------------------------------

/**
 * EVERY L0 fault code, as a type. The two arrays above are the halves; this is their union, and it is
 * what makes `L0_FAULT_NAMES` TOTAL — a `Record<string, …>` would have forced a `?? 'unknown'` fallback
 * at every read, which is shim shape #4 (a runtime default standing in for a type that could have
 * expressed the invariant). With the union, a new fault added without a name is a COMPILE error, and
 * neither reader needs a defensive branch.
 */
export type L0FaultCode = typeof L0_SH_FAULT_CODES[number] | typeof L0_JS_FAULT_CODES[number];

/**
 * The stable, human-readable GUARD NAME per fault code — what goes in the deny's `[…]` header, in the
 * matrix doc's own `guard` column, and nowhere else in a second spelling.
 *
 * L1 prints `[stale-main-bash-guard] (1 violation)` and L0 printed nothing comparable; the names below
 * are deliberately in that same kebab shape so the two layers read as one system. They are IDENTITY, not
 * prose: renaming one silently breaks a grep that spans all three artifacts, exactly as renumbering an
 * L1 row would (see L1_ROWS' header).
 */
export const L0_FAULT_NAMES: Readonly<Record<L0FaultCode, string>> = {
    [L0_FAULT_DRIFT]: 'version-drift',
    [L0_FAULT_BIN_MISSING]: 'guard-bin-missing',
    [L0_FAULT_UNDECLARED]: 'guard-pkg-undeclared',
    [L0_FAULT_BIN_BROKEN]: 'guard-bin-crashed',
    [L0_FAULT_SHIM_STALE]: 'managed-hook-surface',
    [L0_FAULT_CONFIG_MISSING]: 'config-missing',
    [L0_FAULT_CONFIG_OUT_OF_SYNC]: 'config-out-of-sync',
};

/**
 * The LAYER token — the other half of every join key, spelled once. The deny header, the matrix
 * citation, the sh audit line and guards/L0-tooling.md all read it from here, so `grep layer=L0` cannot
 * miss an artifact that typed the token itself.
 */
export const L0_LAYER = 'L0';

/**
 * The three rows of L0's decision matrix, by number — the numbers `renderGuardMatrixDoc` prints, the
 * numbers the audit line's `row=` carries, and the numbers a deny cites. L0's matrix has no genuine
 * second dimension: every branch reduces to `fault present?` x `on the allowlist?`.
 *
 * All three are named because all three are LOGGED: the sh half writes a line for the healthy hand-down
 * too (`PASS-BIN-ALLOW`), which is the line that tells "the guard ran and found nothing" apart from
 * "the guard never ran".
 */
export const L0_ROW_HANDED_DOWN = '1';

/** Row 2: a fault is present but the call is on the L0 allowlist — a cure, a Read, or the config edit. */
export const L0_ROW_ALLOWLISTED = '2';

/** Row 3: a fault is present and the call is NOT on the allowlist. The one row that ever BLOCKS. */
export const L0_ROW_BLOCKED = '3';

/**
 * The `[guard-name] (layer=L0 fault=<code> row=<n>)` header every L0 deny opens with, after the ❌ line.
 *
 * ONE builder, called by the JS denies directly and interpolated into the POSIX-sh denies at render
 * time by renderShim() — so the sh half cannot spell the coordinates differently from the JS half even
 * though it cannot import anything at runtime. `detail` is the per-fault count that mirrors
 * formatReport's `(N violations)`.
 */
// webpieces-disable no-function-outside-class -- pure string builder over this leaf module's own constants; it must stay importable by the dependency-free shim renderer.
export function l0GuardHeader(fault: L0FaultCode, detail: string): string {
    return `[${L0_FAULT_NAMES[fault]}] (layer=${L0_LAYER} fault=${fault} row=${L0_ROW_BLOCKED}, ${detail})`;
}

/**
 * The one-line citation of WHICH matrix row was taken and on what dimension values — L1's pattern
 * (its deny cites "`w` / `n` / `n` - row 8"), in L0's own two columns.
 */
// webpieces-disable no-function-outside-class -- sibling of l0GuardHeader in this leaf codebook module.
export function l0MatrixCitation(fault: L0FaultCode): string {
    return `matrix row ${L0_ROW_BLOCKED}: fault=${fault} present / on the allowlist? no -> BLOCK. Those are the same coordinates the audit line carries (layer=${L0_LAYER} row=${L0_ROW_BLOCKED} fault=${fault}) and the same row webpieces.guard-matrix.md prints.`;
}
