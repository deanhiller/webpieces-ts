import {
    ChangedFilesOptions, ChecklistReviewContext, DiffScope, PrContext, ReviewJsonService,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { DiffBasis } from './diff-basis';

/**
 * Writes `pr-context.json` (the 3-point base/head sha + the FULL changed-file set) and returns the context
 * every printed review instruction inlines.
 *
 * Extracted so `wp-start-upsert-pr` and `wp-review-upsert-pr` cannot diverge. It used to live only in wp-start,
 * which meant `wp-review-upsert-pr` — the command wp-start tells the AI to run FIRST — silently rendered its
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
     * Compute + persist the context against the {@link DiffBasis} the CALLER already resolved, so the range
     * a reviewer is told to diff is byte-identical to the one the pattern matching used. Returns an EMPTY
     * context when the basis has no fork point — callers must say so out loud rather than quietly omit the
     * lines it would have filled; see ChecklistInstructionsService.diffLines.
     *
     * Taking a DiffBasis rather than a bare `forkPoint: string` is the fix, not a refactor: with a lone sha
     * this method had no way to know whether the tree was dirty, so it recorded `head:'HEAD'` and every
     * downstream reader assembled a commit-to-commit command that shows nothing when work is uncommitted.
     *
     * Two things mirror ChecklistScanner deliberately: no head argument to `getChangedFiles` (so the working
     * tree and untracked files are included, not just commits), and `tsOnly:false` (the default drops every
     * *.sql / Dockerfile / .env* file a checklist most wants to key on). `includeDeletions` is on for the
     * same reason: a DELETED migration is exactly what a checklist wants to see.
     */
    ensure(repoRoot: string, featureName: string, basis: DiffBasis, diffDir = ''): ChecklistReviewContext {
        if (basis.unresolved) return new ChecklistReviewContext();
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        opts.includeDeletions = true;
        const changed = this.diffScope.getChangedFiles(repoRoot, basis.base, undefined, opts);
        const p = this.reviewJsonService.writePrContext(repoRoot, featureName, new PrContext(
            basis.base, basis.headSha, changed,
            basis.dirty, basis.dirtyFiles, basis.diffCommand, diffDir, new Date().toISOString(),
        ));
        return new ChecklistReviewContext(basis.base, p, basis.fileDiffCommand, diffDir, basis.dirty);
    }
}
