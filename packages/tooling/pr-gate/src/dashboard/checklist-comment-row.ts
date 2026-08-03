/**
 * One roster line of the checklist COMMENT: a defined checklist, whether its reviewer ran, and the evidence
 * for WHY. Deliberately separate from {@link ChecklistRow} rather than five more fields on it — ChecklistRow
 * also feeds the PR body and the squash-commit body, and roster evidence has no business travelling into
 * main's git history or through every DashboardInput construction site.
 *
 * Kept in pr-gate, not rules-config: the shape of a GitHub comment is this package's concern, and
 * rules-config is the dependency, not the dependent. Its own FILE (rather than sitting in dashboard.ts)
 * per the one-class-per-file convention — dashboard.ts is a large renderer against a hard max-file-lines
 * limit, while this is a data class its consumers construct directly: finish builds these, Dashboard only
 * reads them.
 */
export class ChecklistCommentRow {
    subagent: string; // the reviewer / checklist id
    status: string; // CK_* verdict; '' when it did not run
    detail: string; // verbatim reviewer output
    ran: boolean; // false = skipped, which is a NORMAL, healthy outcome
    // The checklist's CONFIGURED globs. The only safe signal for "always runs": a patternless checklist and
    // a skipped one both have an empty `firedPatterns`, and they mean opposite things.
    configuredPatterns: string[];
    firedPatterns: string[]; // which configured globs actually hit a changed file
    matchedFiles: string[];
    changedFileCount: number; // how many files were considered at all — "0 of N" needs the N
    /**
     * Whether this reviewer's own transcript shows it OPENING the extracted diff.
     *
     * '' = not assessed (no Claude Code session, or nothing was materialized) and prints nothing — "no
     * evidence recorded" and "evidence says it never looked" are different claims, and conflating them
     * would accuse a reviewer that ran perfectly well in CI. 'yes' | 'no' otherwise. Defaulted, so every
     * existing construction site is unchanged.
     */
    diffRead: string = '';
    /**
     * The checklist's configured `required`. Published because "no verdict" means two opposite things and the
     * roster is the only place a reader can tell them apart: a REQUIRED checklist with no verdict could not
     * have opened this PR at all, so seeing one means something went wrong; an OPTIONAL one with no verdict
     * is a review the human was offered and declined, which is the feature working.
     *
     * Defaulted to the blocking value so every existing construction site is unchanged and a row that forgets
     * to set it is reported as the stricter of the two.
     */
    required: boolean = true;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        subagent: string,
        status: string,
        detail: string,
        ran: boolean,
        configuredPatterns: string[],
        firedPatterns: string[],
        matchedFiles: string[],
        changedFileCount: number,
    ) {
        this.subagent = subagent;
        this.status = status;
        this.detail = detail;
        this.ran = ran;
        this.configuredPatterns = configuredPatterns;
        this.firedPatterns = firedPatterns;
        this.matchedFiles = matchedFiles;
        this.changedFileCount = changedFileCount;
    }
}
