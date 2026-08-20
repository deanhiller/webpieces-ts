import { writeTemplate } from '@webpieces/rules-config';

import { toError } from './to-error';
import { BlockedResult } from './types';

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

// ---------------------------------------------------------------------------
// THE POINTER — the half that makes the delivered copy reachable AT THE MOMENT OF THE DENY.
//
// Shipping `webpieces.location-matrix.md` fixed the record; it did not fix the experience. An agent
// told `layer=L1 row=6` while it is BLOCKED reads exactly one thing: the deny text. If that text does
// not name the table, the table may as well not exist — the doc only helps at the moment of the deny.
// L0 (`guardMatrixPointer`) and L2 (`branchStateMatrixPointer`) both name theirs; L1 did not, which is
// the gap PR #696 shipped the doc for and flagged as still open.
//
// So this is the same three-piece mechanism l2-matrix-doc.ts documents in full, applied to L1:
//   the DOC      LOCATION_MATRIX_DOC above, byte-locked to renderL1Doc() by l1-matrix.spec.ts.
//   the WRITE    lazy and best-effort, ONLY on a block — an agent that is not blocked does not need
//                it, and a failed write must cost the reader a pointer, never turn their deny into a
//                stack trace.
//   the POINTER  an ABSOLUTE path, opening with a NEWLINE and carrying no quotes or backslashes.
//
// It is appended in ONE place — `runner.l1LocationBlock`, the single scope every L1 deny funnels
// through, holding the matched row and the resolved tree at once. That is deliberately the same scope
// that already logs `row=`, so the pointer and the log line cannot name different rows.
// ---------------------------------------------------------------------------

/**
 * Drop the L1 matrix where the AI can read it, and return its absolute path ('' if it could not be
 * written).
 *
 * Best-effort by design, exactly as `writeGuardMatrixDoc` and `writeBranchStateMatrixDoc` are: this
 * runs on a path that is already denying the call, and a missing template (a `@webpieces/rules-config`
 * older than this package) must cost the reader a pointer, never a stack trace.
 *
 * MODULE-PRIVATE, unlike L0's and L2's, and that is the difference worth keeping: those two export the
 * write and the pointer separately because several rule files compose them by hand. L1 composes them in
 * exactly one place — `withLocationMatrixPointer` below — so exporting this as well would be a second
 * spelling of the same delivery, and callers could reach for the half that emits no pointer.
 */
// webpieces-disable no-function-outside-class -- sibling of locationMatrixPointer, the shape L0's writeGuardMatrixDoc already established
function writeLocationMatrixDoc(workspaceRoot: string): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return writeTemplate(workspaceRoot, LOCATION_MATRIX_DOC);
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: no doc → the deny simply omits the pointer
        return '';
    }
}

/**
 * The pointer appended to an L1 deny, or '' when the doc could not be written.
 *
 * Opens with a NEWLINE and carries no quotes or backslashes, for the same two reasons L0's and L2's
 * do: the deny renders in the house format (a header, a `[guard-name]` block, `Fix Option N:` lines)
 * so a pointer glued onto the last line is the one place that shape breaks; and the text is
 * interpolated into a JSON payload, where a quote would corrupt the decision rather than merely the
 * prose.
 *
 * It names the ROW as well as the path — including the pre-stage `0`, which is a real row in the
 * delivered table precisely so this pointer can name it. A bare "read this doc" is a page; a row
 * number is the two lines that explain this exact verdict, and the L1-decisions log line for this
 * same call carries the same `row=`.
 */
// webpieces-disable no-function-outside-class -- sibling of writeLocationMatrixDoc, mirroring l0-matrix.ts and l2-matrix-doc.ts
export function locationMatrixPointer(docPath: string, row: string): string {
    if (docPath === '') return '';
    return `\nThe full L1 location matrix - every row, its cure, and the observed use cases it covers - is at ${docPath}; this call was judged by ROW ${row}, and the L1-decisions log line for it carries the same row=. READ that row if you are unsure why this call was blocked.`;
}

/**
 * The write and the pointer, applied to one L1 deny — the whole delivery mechanism in one call.
 *
 * `runner.l1LocationBlock` uses this on EVERY branch, which is the point: that is the single scope
 * every L1 deny funnels through and the same scope that logs `row=`, so the deny and the trail cannot
 * name different rows, and no L1 block path added later can silently skip the pointer. The three report
 * builders keep owning their own deny prose — none of them learns about the doc, which is what keeps
 * this from becoming three near-identical stanzas that drift apart.
 *
 * `null` in, `null` out: the tree-based builders own a predicate of their own and can still decline
 * (see `versionSkewBlock`). No deny, no write, no pointer.
 */
// webpieces-disable no-function-outside-class -- sibling of the two functions above; this module is the L1 doc's delivery, and a lone class would break its shape
export function withLocationMatrixPointer(block: BlockedResult | null, root: string, row: string): BlockedResult | null {
    if (block === null) return null;
    const pointer = locationMatrixPointer(writeLocationMatrixDoc(root), row);
    if (pointer === '') return block;
    return new BlockedResult(block.report + pointer, block.fault);
}
