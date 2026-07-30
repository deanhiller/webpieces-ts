import {
    ChangedFilesOptions, ChecklistReviewContext, DiffScope, PrContext, ReviewJsonService,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * Writes `pr-context.json` (the 3-point base/head sha + the FULL changed-file set) and returns the context
 * every printed review instruction inlines.
 *
 * Extracted so `wp-start-upsert-pr` and `wp-checklist` cannot diverge. It used to live only in wp-start,
 * which meant `wp-checklist` — the command wp-start tells the AI to run FIRST — silently rendered its
 * reviewer blocks with NO `git diff` command and NO full-file-set path whenever wp-start had not run this
 * cycle. A reviewer handed filenames and no way to read the diff is exactly the failure this instruction
 * exists to prevent, and it failed silently, which is worse.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class PrContextWriter {
    constructor(
        private readonly diffScope: DiffScope,
        private readonly reviewJsonService: ReviewJsonService,
    ) {}

    /**
     * Compute + persist the context against the fork point the CALLER already resolved, so the sha a
     * reviewer is told to diff against is byte-identical to the one the pattern matching used. Returns an
     * EMPTY context when `forkPoint` is '' (no fork point from main) — callers must say so out loud rather
     * than quietly omit the lines it would have filled; see ChecklistInstructionsService.diffLines.
     *
     * Two things mirror ChecklistScanner deliberately: no head argument to `getChangedFiles` (so the
     * working tree and untracked files are included, not just commits), and `tsOnly:false` (the default
     * drops every *.sql / Dockerfile / .env* file a checklist most wants to key on).
     */
    ensure(repoRoot: string, featureName: string, forkPoint: string): ChecklistReviewContext {
        if (forkPoint === '') return new ChecklistReviewContext();
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        const changed = this.diffScope.getChangedFiles(repoRoot, forkPoint, undefined, opts);
        const p = this.reviewJsonService.writePrContext(
            repoRoot, featureName, new PrContext(forkPoint, 'HEAD', changed),
        );
        return new ChecklistReviewContext(forkPoint, p);
    }
}
