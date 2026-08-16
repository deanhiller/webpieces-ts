import { writeTemplate } from '@webpieces/rules-config';

import { toError } from './to-error';

// ---------------------------------------------------------------------------
// The L2 matrix, DELIVERED — dropped where a blocked agent can read it, and named in the deny.
//
// L0 has done this since the config-missing fault: `writeGuardMatrixDoc` drops
// webpieces.guard-matrix.md into `.webpieces/instruct-ai/` on a BLOCK, and `guardMatrixPointer` puts
// its ABSOLUTE path in the deny text. L2 had the better table and none of the delivery: its rows,
// their cures and their use cases lived in `guards/L2-branch-state.md`, a path an agent has no reason
// to know and every reason not to find — while the deny it was actually reading named no doc at all.
//
// So this is L0's mechanism, applied to L2. Same three pieces, same reasons:
//
//   the DOC      a rules-config TEMPLATE, byte-locked to renderL2Doc() by l2-matrix.spec.ts, so the
//                delivered copy cannot describe a table the guards no longer have.
//   the WRITE    lazy and best-effort, ONLY on a block. An agent that is not blocked does not need it,
//                and a failed write must degrade the deny, never replace it with a crash.
//   the POINTER  an ABSOLUTE path. A relative one is unusable: the shell's cwd is not the governed
//                root and cannot be assumed (see EffectiveTree), which is the same reason L1's
//                messages name `<root>` explicitly rather than telling the agent to `cd` first.
//
// WHY THE POINTER AND THE `cure=` LOG FIELD SHIP TOGETHER (matrix-cures.ts is the other half): the
// deny hands the agent the row's cure and the path to the table that cure came from; the log records
// the row AND that same cure literal. So "what did the guard tell it to do" is answerable from the
// trail alone, and comparing the two is how you find a row whose use cases need updating — which is
// the whole point of keeping use cases as row data.
// ---------------------------------------------------------------------------

/** The delivered copy of guards/L2-branch-state.md, as a rules-config template name. */
export const BRANCH_STATE_MATRIX_DOC = 'webpieces.branch-state-matrix.md';

/**
 * Drop the L2 matrix where the AI can read it, and return its absolute path ('' if it could not be
 * written).
 *
 * Best-effort by design, exactly as `writeGuardMatrixDoc` is: this runs on a path that is already
 * denying the call, and a missing template (a `@webpieces/rules-config` older than this package) must
 * cost the reader a pointer, never turn their deny into a stack trace.
 */
// webpieces-disable no-function-outside-class -- sibling of branchStateMatrixPointer, the shape L0's writeGuardMatrixDoc already established
export function writeBranchStateMatrixDoc(workspaceRoot: string): string {
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        return writeTemplate(workspaceRoot, BRANCH_STATE_MATRIX_DOC);
    } catch (err: unknown) {
        const error = toError(err);
        void error; // best-effort: no doc → the deny simply omits the pointer
        return '';
    }
}

/**
 * The `READ <path>` pointer appended to an L2 deny, or '' when the doc could not be written.
 *
 * Opens with a NEWLINE and carries no quotes or backslashes, for the same two reasons L0's does: the
 * deny renders in the house format (a header, a `[guard-name]` block, `Fix Option N:` lines) so a
 * pointer glued onto the last line is the one place that shape breaks; and the text is interpolated
 * into a JSON payload, where a quote would corrupt the decision rather than merely the prose.
 *
 * It names the ROW as well as the path. A bare "read this doc" is a page; a row number is the two
 * lines that explain this exact verdict, and the log line for this call carries the same number.
 */
// webpieces-disable no-function-outside-class -- sibling of writeBranchStateMatrixDoc, mirroring l0-matrix.ts
export function branchStateMatrixPointer(docPath: string, row: string): string {
    if (docPath === '') return '';
    return `\nThe full L2 branch-state matrix - every row, its cure, and the observed use cases it covers - is at ${docPath}; this call was judged by ROW ${row}, and the L2-decisions log line for it carries the same row= and cure=. READ that row if you are unsure why this call was blocked.`;
}
