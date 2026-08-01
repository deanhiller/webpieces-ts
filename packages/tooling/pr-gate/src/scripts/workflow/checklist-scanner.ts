import {
    ChangedFilesOptions, ChecklistDefinition, ChecklistResult, ChecklistReviewContext, DiffScope,
    RequiredChecklist, ReviewJsonService, reviewJsonPath,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { ChecklistDetector, ChecklistRoster } from './checklist-detector';
import { DiffBasis, DiffBasisResolver } from './diff-basis';
import { PrContextWriter } from './pr-context-writer';

/** How a caller wants the scan filtered. Data-only (per CLAUDE.md). */
export class ChecklistScanOptions {
    /**
     * false — `outstanding` is every applicable checklist (what `wp-review-upsert-pr` LISTS).
     * true  — `outstanding` drops the ones already carrying a passing/overridden verdict, leaving only what
     *         still owes review (what `wp-finish-upsert-pr` BLOCKS on).
     */
    filterAlreadyReviewed: boolean;
    /**
     * Which per-stage snapshot this scan should persist ('stage3-finish', …), or '' for "do not write
     * pr-context.json here".
     *
     * '' exists for stage ②, which cannot write yet: the context records `diffDir`, and the diff has not
     * been materialized at scan time. Letting the scan write anyway meant stage ② wrote the file twice,
     * ~60 lines apart, the first time with an empty diffDir. Now it writes once, after materializing.
     *
     * The DEFAULT is deliberately non-empty, so writing is what you get by NOT thinking about it. A
     * reviewer block that lost its diff command because nobody had written pr-context.json is a bug this
     * codebase has already shipped once (see PrContextWriter's docstring); opting out must be an explicit,
     * visible act by a caller that takes responsibility for writing it later — not an omission.
     */
    contextStage: string;

    constructor(filterAlreadyReviewed = false, contextStage = 'stage-scan') {
        this.filterAlreadyReviewed = filterAlreadyReviewed;
        this.contextStage = contextStage;
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
    /**
     * The basis the matching ACTUALLY ran against. Carried out so a caller that materializes the diff
     * (stage ②) reuses the identical range instead of resolving its own — two independent resolutions is
     * exactly how the changed-file set and the printed `git diff` command came to disagree.
     */
    basis: DiffBasis;
    changedFiles: string[];              // the full changed-file set the matching ran against
    /**
     * The verdict files the scan ALREADY read, carried out rather than dropped.
     *
     * `outstanding` answers "who still owes a verdict?" but not "why" — and the two reasons demand opposite
     * actions from the reader: a reviewer that never ran must be SPAWNED, a reviewer that ran and REFUSED
     * must not be (it will refuse again; the finding has to be fixed first). Telling them apart means
     * resolving each checklist's verdict, and without the results here every caller either re-reads the same
     * files off disk — a second read that can disagree with this one — or merges the two cases into one
     * message, which is exactly the loop this field exists to break.
     */
    results: ChecklistResult[];

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
        basis: DiffBasis = new DiffBasis(),
        changedFiles: string[] = [],
        // Defaulted so a caller that only cares about the X/N/Z counts (and every existing test construction)
        // stays a one-liner; the scanner itself always passes the real set.
        results: ChecklistResult[] = [],
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
        this.basis = basis;
        this.changedFiles = changedFiles;
        this.results = results;
    }
}

/**
 * The ONE computation of which reviewer subagents a branch owes, shared by `wp-review-upsert-pr` (which lists) and
 * `wp-finish-upsert-pr` (which blocks). They previously each assembled this from the same parts in slightly
 * different ways, and any divergence means the command that reports and the command that gates disagree.
 *
 * Two properties are deliberate and load-bearing:
 *
 * 1. **The base is the FORK POINT of main, computed directly** — never `DiffScope.resolveBase`, which
 *    overlays `NX_BASE`/`NX_HEAD` from the environment. That made review coverage depend on an env var.
 *    It now arrives via {@link DiffBasisResolver}, which injects ForkPoint; same sha, one resolution.
 * 2. **UNCOMMITTED work counts.** `getChangedFiles` is called with NO head, which is the branch of it that
 *    diffs base → WORKING TREE and unions in untracked files. Passing a head would diff commit-to-commit and
 *    silently miss staged, unstaged and untracked changes — so a checklist matching only uncommitted files
 *    would never fire and its reviewer would never be listed.
 * 3. **The range and the command it prints are the SAME basis.** Property 2 used to be true of the file set
 *    only: reviewers were handed `git diff <base> HEAD`, which on a dirty tree covers a different range and
 *    prints nothing. Both now derive from one {@link DiffBasis}, carried on the scan so a materializing
 *    caller cannot re-resolve and drift.
 *
 * `@injectable(bindingScopeValues.Singleton)` so it is injected by type and drawn in the DI design.
 */
@injectable(bindingScopeValues.Singleton)
export class ChecklistScanner {
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly checklistDetector: ChecklistDetector,
        private readonly diffScope: DiffScope,
        private readonly diffBasisResolver: DiffBasisResolver,
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
        // ONE basis for the file set, the reproduce command and any downstream materialization. The fork
        // point still comes from ForkPoint (never DiffScope.resolveBase) — DiffBasisResolver injects it.
        const basis = this.diffBasisResolver.resolve(repoRoot);
        const base = basis.base;
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
            opts.contextStage === ''
                ? this.prContextWriter.contextFor(repoRoot, featureName, basis)
                : this.prContextWriter.ensure(repoRoot, featureName, basis, opts.contextStage, changedFiles),
            reviewPath,
            base,
            roster,
            this.reviewJsonService.checklistFormatErrors(applicable, results),
            basis,
            changedFiles,
            results,
        );
    }

    /**
     * Every file changed since the fork point, INCLUDING uncommitted and untracked ones. Two non-default
     * options, both load-bearing:
     *
     * `tsOnly:false`        — the default drops every *.sql / Dockerfile / .env* file a checklist most wants
     *                         to key on, which would silently shrink the set a reviewer is pointed at.
     * `includeDeletions:true` — the default is `--diff-filter=d`, so a DELETED file is invisible. A PR that
     *                         deletes a migration, an auth check or a terraform rule changed exactly what a
     *                         checklist exists to catch, and under the default no checklist fires at all.
     */
    private changedFiles(repoRoot: string, base: string): string[] {
        if (base === '') return [];
        const opts = new ChangedFilesOptions();
        opts.tsOnly = false;
        opts.includeDeletions = true;
        // No head argument — see the class comment. This is what includes the working tree.
        return this.diffScope.getChangedFiles(repoRoot, base, undefined, opts);
    }
}
