import {
    ChangedFilesOptions, ChecklistDefinition, ChecklistReviewContext, DiffScope, RequiredChecklist,
    ReviewJsonService, reviewJsonPath,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { ChecklistDetector, ChecklistRoster } from './checklist-detector';
import { ForkPoint } from './git-findForkPoint';
import { PrContextWriter } from './pr-context-writer';

/** How a caller wants the scan filtered. Data-only (per CLAUDE.md). */
export class ChecklistScanOptions {
    /**
     * false — `outstanding` is every applicable checklist (what `wp-checklist` LISTS).
     * true  — `outstanding` drops the ones already carrying a passing/overridden verdict, leaving only what
     *         still owes review (what `wp-finish-upsert-pr` BLOCKS on).
     */
    filterAlreadyReviewed: boolean;

    constructor(filterAlreadyReviewed = false) {
        this.filterAlreadyReviewed = filterAlreadyReviewed;
    }
}

/**
 * The answer to "what review does this branch owe?", in the X → N → Z terms the commands report:
 *   X = `defined`     — every checklist in pr-gate.checklists
 *   N = `applicable`  — those whose patterns matched (or that have no patterns, so always run)
 *   Z = `outstanding` — of N, those still owing a verdict (only when filterAlreadyReviewed)
 * Data-only.
 */
export class ChecklistScan {
    defined: ChecklistDefinition[];      // X
    applicable: RequiredChecklist[];     // N
    reviewed: RequiredChecklist[];       // N − Z: already have a passing/warned/overridden review-<id>.json
    outstanding: RequiredChecklist[];    // Z (== applicable when not filtering)
    context: ChecklistReviewContext;     // fork-point sha + pr-context.json path
    reviewPath: string;                  // the branch's review.json; verdict files sit beside it
    forkPoint: string;                   // '' when no fork point resolved
    // ALL X, matched or not, with why — what the PR comment publishes as its roster. Skipped checklists are
    // absent from `applicable` by construction, and recovering them downstream would mean a second
    // changed-file computation with different semantics (see the class comment).
    roster: ChecklistRoster;
    // Verdict files that exist but cannot be read as a verdict (e.g. still using the removed `success`).
    // Carried on the SCAN because wp-finish-upsert-pr refuses on missing reviewers before it ever parses
    // review.json — a complaint raised only in there would never reach the AI.
    formatErrors: string[];

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        defined: ChecklistDefinition[],
        applicable: RequiredChecklist[],
        reviewed: RequiredChecklist[],
        outstanding: RequiredChecklist[],
        context: ChecklistReviewContext,
        reviewPath: string,
        forkPoint: string,
        roster: ChecklistRoster,
        formatErrors: string[],
    ) {
        this.defined = defined;
        this.applicable = applicable;
        this.reviewed = reviewed;
        this.outstanding = outstanding;
        this.context = context;
        this.reviewPath = reviewPath;
        this.forkPoint = forkPoint;
        this.roster = roster;
        this.formatErrors = formatErrors;
    }
}

/**
 * The ONE computation of which reviewer subagents a branch owes, shared by `wp-checklist` (which lists) and
 * `wp-finish-upsert-pr` (which blocks). They previously each assembled this from the same parts in slightly
 * different ways, and any divergence means the command that reports and the command that gates disagree.
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. **The base is the FORK POINT of main, computed directly** — never `DiffScope.resolveBase`, which
 *    overlays `NX_BASE`/`NX_HEAD` from the environment. That made review coverage depend on an env var.
 * 2. **UNCOMMITTED work counts.** `getChangedFiles` is called with NO head, which is the branch of it that
 *    diffs base → WORKING TREE and unions in untracked files. Passing a head would diff commit-to-commit and
 *    silently miss staged, unstaged and untracked changes — so a checklist matching only uncommitted files
 *    would never fire and its reviewer would never be listed. `wp-checklist` is explicitly callable
 *    mid-work, which is exactly when that matters.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistScanner {
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly checklistDetector: ChecklistDetector,
        private readonly diffScope: DiffScope,
        private readonly forkPoint: ForkPoint,
        private readonly prContextWriter: PrContextWriter,
        private readonly reviewJsonService: ReviewJsonService,
    ) {}

    /**
     * `defined` is the caller's ALREADY-VALIDATED `prGate.checklists`. The scanner deliberately does not load
     * config itself: `loadAndValidate` is the one gate on the checklist set (it rejects a non-array
     * `checklists`, including the removed `{ doc }` manifest shape, and verifies every guidance doc and
     * reviewer-agent file exists), both callers already run it for other fields, and keeping the read out of
     * here leaves this a function of its inputs rather than of the filesystem.
     */
    scan(repoRoot: string, defined: ChecklistDefinition[], opts: ChecklistScanOptions): ChecklistScan {
        const featureName = this.aiBranchName.getFeatureName();
        const reviewPath = reviewJsonPath(repoRoot, featureName);
        const base = this.forkPoint.resolveForkPoint(repoRoot);
        // ONE changed-file computation feeds both the roster (all X) and the applicable set (N). `detect` is
        // pure and defined as the roster minus its empty entries, so the two cannot disagree about a match.
        const changedFiles = this.changedFiles(repoRoot, base);
        const roster = new ChecklistRoster(
            this.checklistDetector.roster(defined, changedFiles), changedFiles.length, base !== '');
        const applicable = this.checklistDetector.toRequired(this.checklistDetector.detect(defined, changedFiles));
        const results = this.reviewJsonService.loadChecklistResults(reviewPath, applicable);
        const stillOwed = this.reviewJsonService.pendingChecklists(applicable, results);
        const owedIds = new Set(stillOwed.map((r: RequiredChecklist): string => r.id));
        const reviewed = applicable.filter((r: RequiredChecklist): boolean => !owedIds.has(r.id));
        return new ChecklistScan(
            defined,
            applicable,
            reviewed,
            opts.filterAlreadyReviewed ? stillOwed : applicable,
            this.prContextWriter.ensure(repoRoot, featureName, base),
            reviewPath,
            base,
            roster,
            this.reviewJsonService.checklistFormatErrors(applicable, results),
        );
    }

    /**
     * Every file changed since the fork point, INCLUDING uncommitted and untracked ones. `tsOnly:false` is
     * load-bearing too: the default drops every *.sql / Dockerfile / .env* file a checklist most wants to
     * key on, which would silently shrink the set a reviewer is pointed at.
     */
    private changedFiles(repoRoot: string, base: string): string[] {
        if (base === '') return [];
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        // No head argument — see the class comment. This is what includes the working tree.
        return this.diffScope.getChangedFiles(repoRoot, base, undefined, opts);
    }
}
