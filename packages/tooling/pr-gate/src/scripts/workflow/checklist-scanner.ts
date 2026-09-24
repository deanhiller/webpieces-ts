import {
    ChangedFilesOptions, ChecklistDefinition, ChecklistResult, ChecklistReviewContext, DiffScope,
    HomeConfigService, RequiredChecklist, ReviewJsonService, VERDICT_RED, summaryJsonPath,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { ChecklistDetector, ChecklistRoster } from './checklist-detector';
import { DiffBasis, DiffBasisResolver } from './diff-basis';
import { PrContextWriter } from './pr-context-writer';
import { ChecklistScopeHasher } from './checklist-scope-hasher';
import {
    STANDING_REJECTED, STANDING_STALE, VerdictProvenanceService, VerdictStanding,
} from './verdict-provenance';

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
    summaryPath: string;                  // the branch's summary.json; verdict files sit beside it
    forkPoint: string;                   // '' when no fork point resolved
    // ALL X, matched or not, with why — what the PR comment publishes as its roster. Skipped checklists are
    // absent from `applicable` by construction, and recovering them downstream would mean a second
    // changed-file computation with different semantics (see the class comment).
    roster: ChecklistRoster;
    // Verdict files that exist but cannot be read as a verdict (e.g. still using the removed `success`).
    // Carried on the SCAN because wp-finish-upsert-pr refuses on missing reviewers before it ever parses
    // summary.json — a complaint raised only in there would never reach the AI.
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
     * TRUE when either this machine's `experimental.turnOffAllReviewers` switch is on or the project sets
     * `commands.pr-gate.reviewerAgents: 0`, and therefore when `applicable`, `reviewed`,
     * `outstanding`, `results`, `optionalNotRun` and `formatErrors` above are ALL EMPTY BY DECREE rather
     * than because nothing matched. Those two states are indistinguishable from the empty lists alone,
     * and telling them apart is the entire reason this field exists: an unreviewed PR must never render
     * as a reviewed one.
     *
     * `defined`, `roster`, `basis`, `changedFiles` and `context` are deliberately left INTACT under
     * suppression, so every reader can still say WHAT was switched off — including which REQUIRED
     * checklists would otherwise have run.
     *
     * See `HOME_KEY_TURN_OFF_ALL_REVIEWERS` in rules-config for the flag's contract; it is an
     * `experimental.*` flag, so only a human ever ends it.
     */
    reviewersDisabled: boolean;
    /**
     * The checklists that WOULD have been `applicable` had the reviewers not been suppressed — required
     * ones included. EMPTY on every ordinary run, and empty is not ambiguous there because
     * `reviewersDisabled` is false.
     *
     * Carried by NAME and not as a count because every reader needs a different slice of it: stage ②
     * prints them so a human can see exactly which required reviewer was killed, the dashboard names them
     * in the 1st comment, and the compact PR body needs only `.length`. Recomputing any of that
     * downstream would mean a second changed-file computation that can disagree with this one.
     */
    suppressed: RequiredChecklist[];
    /** TRUE only for the top-level `singleRoundReview` machine opt-in. */
    singleRoundReview: boolean;
    /**
     * How every EXISTING verdict file stands (issue #863): CURRENT (submitted through `wp-write-review` and
     * its checklist's in-scope diff is unchanged — it carries), STALE (in-scope diff changed since — re-brief)
     * or REJECTED (no bin provenance, or edited after submission — it is not a review). A REJECTED verdict,
     * and a STALE green or yellow one, is left OUT of `results`, so it is owed like one that never ran; a
     * stale RED stays in `results` and keeps refusing. Empty under suppression.
     */
    standings: VerdictStanding[];
    /** checklist id → ChecklistScopeHasher's hash of its in-scope diff NOW. Recorded in the stage-② receipt. */
    scopeHashes: Record<string, string>;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        defined: ChecklistDefinition[],
        applicable: RequiredChecklist[],
        reviewed: RequiredChecklist[],
        outstanding: RequiredChecklist[],
        context: ChecklistReviewContext,
        summaryPath: string,
        forkPoint: string,
        roster: ChecklistRoster,
        formatErrors: string[],
        // REQUIRED, and placed BEFORE the defaulted tail deliberately. A defaulted `reviewersDisabled =
        // false` would let every existing construction keep compiling while asserting, silently, that no
        // reviewer was switched off — the widening-by-omission `.claude/rules/no-backwards-compat.md`
        // rejects, and on the one field whose whole job is to stop an unreviewed PR reading as reviewed.
        reviewersDisabled: boolean,
        suppressed: RequiredChecklist[],
        basis: DiffBasis = new DiffBasis(),
        changedFiles: string[] = [],
        // Defaulted so a caller that only cares about the X/N/Z counts (and every existing test construction)
        // stays a one-liner; the scanner itself always passes the real set.
        results: ChecklistResult[] = [],
        optionalNotRun: RequiredChecklist[] = [],
        singleRoundReview = false,
    ) {
        this.defined = defined;
        this.applicable = applicable;
        this.reviewed = reviewed;
        this.outstanding = outstanding;
        this.context = context;
        this.summaryPath = summaryPath;
        this.forkPoint = forkPoint;
        this.roster = roster;
        this.formatErrors = formatErrors;
        this.reviewersDisabled = reviewersDisabled;
        this.suppressed = suppressed;
        this.basis = basis;
        this.changedFiles = changedFiles;
        this.results = results;
        this.optionalNotRun = optionalNotRun;
        this.singleRoundReview = singleRoundReview;
        this.standings = [];
        this.scopeHashes = {};
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
        // Injected BY TYPE (no Symbol token, per CLAUDE.md) so the ONE reviewer kill switch is read in the
        // ONE place that computes what a branch owes — see the suppression note on `scan`.
        private readonly homeConfig: HomeConfigService,
        private readonly scopeHasher: ChecklistScopeHasher,
        private readonly verdictProvenance: VerdictProvenanceService,
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
        const summaryPath = summaryJsonPath(repoRoot, featureName);
        // ONE basis for the file set, the reproduce command and any downstream materialization. The fork
        // point still comes from ForkPoint (never DiffScope.resolveBase) — DiffBasisResolver injects it.
        const basis = this.diffBasisResolver.resolve(repoRoot);
        const base = basis.base;
        // ONE changed-file computation feeds both the roster (all X) and the applicable set (N). `detect` is
        // pure and defined as the roster minus its empty entries, so the two cannot disagree about a match.
        const changedFiles = this.changedFiles(repoRoot, base);
        const roster = new ChecklistRoster(
            this.checklistDetector.roster(defined, changedFiles), changedFiles.length, base !== '');
        const matched = this.checklistDetector.toRequired(this.checklistDetector.detect(defined, changedFiles));
        // THE ONE CHOKE POINT for both reviewer opt-outs. Suppressing HERE — rather than in
        // `wp-review-upsert-pr` and again in `wp-finish-upsert-pr` — is what keeps the command that LISTS
        // and the command that BLOCKS in agreement by construction, which is this class's whole reason for
        // existing. A second check in either command would be a second answer to one question.
        const context = opts.contextStage === ''
            ? this.prContextWriter.contextFor(repoRoot, featureName, basis)
            : this.prContextWriter.ensure(repoRoot, featureName, basis, opts.contextStage, changedFiles);
        const homeConfig = this.homeConfig.load();
        const projectDisabled = defined.some((d: ChecklistDefinition): boolean => d.reviewer.maxAgents === 0);
        if (homeConfig.turnOffAllReviewers || projectDisabled) {
            // EMPTY: applicable, reviewed, outstanding, formatErrors, results, optionalNotRun. INTACT:
            // defined, roster, basis, changedFiles, context — so every downstream reader can still say
            // WHAT was suppressed, which is the difference between an honest record and a silent one.
            return new ChecklistScan(
                defined, [], [], [], context, summaryPath, base, roster, [], true, matched, basis,
                changedFiles, [], [], homeConfig.singleRoundReview);
        }
        const applicable = matched;
        const scopeHashes = this.scopeHasher.hashes(repoRoot, basis, applicable);
        const loaded = this.reviewJsonService.loadChecklistResults(summaryPath, applicable);
        const standings = this.standingsOf(summaryPath, loaded, scopeHashes, homeConfig.singleRoundReview);
        const results = this.liveResults(loaded, standings);
        const stillOwed = this.reviewJsonService.pendingChecklists(applicable, results);
        const owedIds = new Set(stillOwed.map((r: RequiredChecklist): string => r.id));
        // NOT `!owedIds.has(...)`-with-the-optional-exemption-folded-in: an optional checklist nobody ran is
        // neither reviewed nor blocking, and calling it "reviewed" would put a ✓ on the dashboard for a review
        // that never happened.
        const reviewed = applicable.filter((r: RequiredChecklist): boolean => !owedIds.has(r.id));
        const optionalNotRun = this.reviewJsonService.optionalWithoutVerdict(applicable, results);
        const scan = new ChecklistScan(
            defined,
            applicable,
            reviewed,
            opts.filterAlreadyReviewed ? this.blocking(stillOwed, optionalNotRun) : applicable,
            context,
            summaryPath,
            base,
            roster,
            this.reviewJsonService.checklistFormatErrors(applicable, results),
            false,
            [],
            basis,
            changedFiles,
            results,
            optionalNotRun,
            homeConfig.singleRoundReview,
        );
        scan.standings = standings;
        scan.scopeHashes = scopeHashes;
        return scan;
    }

    /**
     * Judge every READABLE verdict against its bin provenance and the in-scope diff as it is now. A file
     * with a format problem is left to the format complaint, which names the fix; it is not assessed.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private standingsOf(
        summaryPath: string, loaded: readonly ChecklistResult[], scopeHashes: Record<string, string>, singleRound: boolean,
    ): VerdictStanding[] {
        return loaded
            .filter((r: ChecklistResult): boolean => r.problem === '')
            .map((r: ChecklistResult): VerdictStanding =>
                this.verdictProvenance.assess(summaryPath, r, scopeHashes[r.id] ?? '', singleRound));
    }

    /**
     * The verdicts that still COUNT. A rejected one never does. A stale green or yellow judged code that
     * has since changed, so it is owed again; a stale RED still refuses — a refusal is not lifted by
     * changing other code in its scope, only by a fresh verdict — and it is re-briefed anyway because it
     * is red.
     */
    private liveResults(loaded: readonly ChecklistResult[], standings: readonly VerdictStanding[]): ChecklistResult[] {
        const dropped = new Set(standings
            .filter((s: VerdictStanding): boolean =>
                s.standing === STANDING_REJECTED || (s.standing === STANDING_STALE && s.status !== VERDICT_RED))
            .map((s: VerdictStanding): string => s.checklistId));
        return loaded.filter((r: ChecklistResult): boolean => !dropped.has(r.id));
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
