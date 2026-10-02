import { L1_ROWS, L1Row } from './l1-rows';
import { L2_ROWS, L2Row } from './l2-rows';

// ---------------------------------------------------------------------------
// THE CURE, as a log field — the other half of `row=`.
//
// `row=` already joined a decision-log line to a row in the generated matrix. What it could not tell
// you is what the agent was actually TOLD to do, and that is the half you need to audit the table:
// a row whose cure keeps appearing in the trail next to a session that then did something else is a
// row whose use cases need updating. Reading the doc tells you what the cure IS; reading the log used
// to tell you only that some row fired.
//
// THE ONE DESIGN DECISION HERE: the cure is LOOKED UP from the row, never passed in by the caller.
//
// A `cure` field on GuardDecision would have been the obvious move and is the wrong one. It would let
// the logged cure and the printed cure drift — two spellings of one thing, which is the shim shape
// this repo rejects — and it would have to be threaded through every construction site, so the cheap
// path would be to pass '' and the field would rot. Deriving it from `decision.matrix` means the
// logged cure is BY CONSTRUCTION the same literal the generated doc prints for that row, and no call
// site changes at all.
//
// Both layers are covered because both stamp a MatrixRef: L1 dispatches from L1_ROWS, L2 joins by
// reason. L0's cures are a different shape (L0Cure carries mention + discriminator + guidance, and
// the sh shim prints them itself), so L0 rows resolve to '-' here rather than being half-rendered.
// ---------------------------------------------------------------------------

/** What a row with no cure — every ALLOW row, and every layer this module does not own — logs. */
export const NO_CURE = '-';

/**
 * The literal cure for a layer+row, for the log line. `-` when the row allows, or when the layer is
 * not one this module owns.
 *
 * Markdown backticks are stripped: the doc is read by a human in a renderer, the log is read through
 * `grep`, and a cure you cannot grep for without escaping the fence characters is a cure the trail
 * cannot be searched by. The words are otherwise untouched, so the log and the doc stay comparable
 * literal-for-literal, which is the point of deriving one from the other.
 */
// webpieces-disable no-function-outside-class -- the pure lookup this module exists to be, over the two row arrays it imports
export function cureForMatrix(layer: string, row: string): string {
    if (layer === 'L2') return cureOf(L2_ROWS.find((r: L2Row): boolean => String(r.num) === row)?.cure);
    if (layer === 'L1') return cureOf(L1_ROWS.find((r: L1Row): boolean => String(r.num) === row)?.cure?.denyMention);
    return NO_CURE;
}

// An allow row's cure cell is the em-dash the doc prints; in a log field that is noise, so it becomes
// the same `-` an unknown row gets. The distinction a reader needs is carried by `verdict`, not here.
// webpieces-disable no-function-outside-class -- private normalizer for cureForMatrix above, beside it in this module
function cureOf(cure: string | undefined): string {
    if (cure === undefined || cure === '' || cure === '—') return NO_CURE;
    return cure.replace(/`/g, '');
}
