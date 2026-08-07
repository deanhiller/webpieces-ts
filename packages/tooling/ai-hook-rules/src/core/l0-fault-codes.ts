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
 * calls left two lines in hook-rejection.log, both attributed to a downstream rule, and nothing
 * anywhere identifying L0.
 */
export const L0_JS_FAULT_CODES = [
    L0_FAULT_SHIM_STALE, L0_FAULT_CONFIG_MISSING, L0_FAULT_CONFIG_OUT_OF_SYNC,
] as const;
