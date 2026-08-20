// ---------------------------------------------------------------------------
// The L1 matrix, DELIVERED — the same treatment L0 and L2 already had.
//
// THE GAP THIS CLOSES. L1 stamps `layer=L1 row=<n>` on every decision it makes: a fleet audit counted
// 1,457 of them across nine repos, with rows 0, 1, 4, 5, 6 and 7 all in active use. `.webpieces/instruct-ai/`
// shipped a matrix for L2 (`webpieces.branch-state-matrix.md`) and one for L0 (`webpieces.guard-matrix.md`)
// — and NOTHING for L1. An agent told "L1 row 6" had nowhere to look it up.
//
// The table itself was never missing; `guards/L1-location.md` has been generated from `L1_ROWS` for
// releases. What was missing is DELIVERY: `guards/` is a path in webpieces' own repo, not something a
// consumer repo has. So this names the delivered copy, `generate-guard-docs.ts` writes it from the same
// `renderL1Doc()` that writes `guards/L1-location.md`, and `l1-matrix.spec.ts` byte-locks the two
// together — the delivered page cannot describe a table the guards no longer have.
// ---------------------------------------------------------------------------

/** The delivered copy of `guards/L1-location.md`, as a rules-config template name. */
export const LOCATION_MATRIX_DOC = 'webpieces.location-matrix.md';
