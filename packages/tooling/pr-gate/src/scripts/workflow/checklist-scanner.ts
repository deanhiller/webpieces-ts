import {
    AuthorizationContext, AuthorizedOverrides, ChecklistDefinition, ChecklistResult,
    ChecklistReviewContext, HumanAuthorizationService, RequiredChecklist, ReviewJsonService,
    reviewJsonPath,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { ChecklistDetector, ChecklistRoster } from './checklist-detector';
import { DiffBasis, DiffBasisResolver } from './diff-basis';
import { PrContextWriter } from './pr-context-writer';
import { ReviewChangedFiles } from './authorization-context-resolver';

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

    /**
     * The repo's `prGate.gateSalt` — the HMAC key human authorizations are verified with.
     *
     * It is passed IN rather than loaded here for the same reason `defined` is (see {@link ChecklistScanner.scan}):
     * both callers already run `loadAndValidate`, and a scanner that reads config is a function of the
     * filesystem rather than of its inputs. The default '' fails CLOSED — no approval verifies under an empty
     * salt, so a caller that forgets it refuses every override rather than honouring an unsigned one.
     */
    gateSalt: string;

    constructor(filterAlreadyReviewed = false, contextStage = 'stage-scan', gateSalt = '') {
        this.filterAlreadyReviewed = filterAlreadyReviewed;
        this.contextStage = contextStage;
        this.gateSalt = gateSalt;
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
    /**
     * The OPTIONAL (`required: false`) applicable checklists carrying no verdict file — i.e. nobody ran them.
     *
     * Deliberately NOT in `outstanding` when filtering: that is the exemption that makes `required: false`
     * mean something. Carried out as its own set rather than merely subtracted, because both readers need it
     * BY NAME and neither can recover it from what is left: stage ② offers exactly these to the human, and
     * the PR dashboard must publish them as "not run" rather than let a shorter roster imply everything
     * passed. An optional checklist that ran and went RED is absent from here and stays in `outstanding`.
     */
    optionalNotRun: RequiredChecklist[];
    /**
     * The human authorizations that VERIFY for this branch right now — the only thing that turns a
     * reviewer's `override` into a shipping verdict.
     *
     * Carried on the scan for the same reason `results` is: it is an input to every verdict, and a caller
     * that re-resolved it would be verifying against a second reading of the fork point and changed-file
     * set. One resolution, one answer, or the command that gates and the command that reports disagree
     * about whether the human said yes.
     */
    authorized: AuthorizedOverrides;

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
        optionalNotRun: RequiredChecklist[] = [],
        // Defaulted to the EMPTY grant so a construction that forgets it authorizes nothing. Fails closed.
        authorized: AuthorizedOverrides = new AuthorizedOverrides(),
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
        this.optionalNotRun = optionalNotRun;
        this.authorized = authorized;
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
 * 2. **UNCOMMITTED work counts**, and the set comes from {@link ReviewChangedFiles} — the one place that
 *    computation lives, shared with the authorization commands so a checklist's scope and an approval's
 *    scope are literally the same file set rather than two implementations of it.
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
        private readonly reviewChangedFiles: ReviewChangedFiles,
        private readonly diffBasisResolver: DiffBasisResolver,
        private readonly prContextWriter: PrContextWriter,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly humanAuthorization: HumanAuthorizationService,
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
        const changedFiles = this.reviewChangedFiles.since(repoRoot, base);
        const roster = new ChecklistRoster(
            this.checklistDetector.roster(defined, changedFiles), changedFiles.length, base !== '');
        const applicable = this.checklistDetector.toRequired(this.checklistDetector.detect(defined, changedFiles));
        const results = this.reviewJsonService.loadChecklistResults(reviewPath, applicable);
        // Resolved ONCE, from the same fork point and changed-file set the matching ran against — the
        // approval's scope is checked against THIS diff, not against a second reading of it.
        const authorized = this.humanAuthorization.verifiedFor(
            repoRoot, new AuthorizationContext(featureName, base, changedFiles), opts.gateSalt);
        const stillOwed = this.reviewJsonService.pendingChecklists(applicable, results, authorized);
        const owedIds = new Set(stillOwed.map((r: RequiredChecklist): string => r.id));
        // NOT `!owedIds.has(...)`-with-the-optional-exemption-folded-in: an optional checklist nobody ran is
        // neither reviewed nor blocking, and calling it "reviewed" would put a ✓ on the dashboard for a review
        // that never happened.
        const reviewed = applicable.filter((r: RequiredChecklist): boolean => !owedIds.has(r.id));
        const optionalNotRun = this.reviewJsonService.optionalWithoutVerdict(applicable, results, authorized);
        return new ChecklistScan(
            defined,
            applicable,
            reviewed,
            opts.filterAlreadyReviewed ? this.blocking(stillOwed, optionalNotRun) : applicable,
            opts.contextStage === ''
                ? this.prContextWriter.contextFor(repoRoot, featureName, basis)
                : this.prContextWriter.ensure(repoRoot, featureName, basis, opts.contextStage, changedFiles),
            reviewPath,
            base,
            roster,
            this.reviewJsonService.checklistFormatErrors(applicable, results, authorized),
            basis,
            changedFiles,
            results,
            optionalNotRun,
            authorized,
        );
    }

    /**
     * What `wp-finish-upsert-pr` actually REFUSES on: everything still owing a verdict, minus the optional
     * checklists nobody ran.
     *
     * The subtraction happens HERE — in the one place `outstanding` is computed — and not in the gate, so
     * there is a single answer to "does this branch owe review?". When the gate did its own filtering, the
     * command that lists and the command that blocks were two implementations of the same question, which is
     * exactly the divergence this class's docstring exists to prevent.
     */
    private blocking(stillOwed: readonly RequiredChecklist[], optionalNotRun: readonly RequiredChecklist[]): RequiredChecklist[] {
        const skipped = new Set(optionalNotRun.map((r: RequiredChecklist): string => r.id));
        return stillOwed.filter((r: RequiredChecklist): boolean => !skipped.has(r.id));
    }
}
