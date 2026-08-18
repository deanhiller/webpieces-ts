import * as fs from 'fs';
import {
    loadAndValidate, writeTemplate, PrGateConfig, RepoRootFinder, RequiredChecklist,
    ReviewerBriefing, ReviewerInstructionsService, ReviewJsonService,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { ActiveHatch, ActiveHatchReport } from '../workflow/active-hatches';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { REVIEW_STAGE } from '../workflow/build-gate-log';
import { BuildArtifactGate } from '../workflow/build-artifact-gate';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { DiffMaterializer } from '../workflow/diff-materializer';
import { GitExec } from '../workflow/git-exec';
import { MergeContext } from '../workflow/merge-start';
import { MergeEnd, MergeEndOptions } from '../workflow/merge-end';
import { MergeState } from '../workflow/merge-state';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { ReviewerBriefingBuilder } from '../workflow/reviewer-briefing-builder';
import { RefusedReviewer, ReviewReport, ReviewReportInput } from '../workflow/review-report';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/** The `--no-optional` decision, as data (per CLAUDE.md) rather than a bare boolean parameter. */
export class ReviewUpsertPrOptions {
    /**
     * true ⇒ the human ALREADY said to submit without the optional reviews, so stage ② must not print the
     * block telling the AI to offer them. It changes nothing about what BLOCKS: required checklists are
     * unaffected, and an optional checklist that already has a red verdict on this branch still refuses the
     * PR at finish. This only suppresses the offer.
     */
    skipOptional: boolean;

    constructor(skipOptional = false) {
        this.skipOptional = skipOptional;
    }
}

/**
 * `wp-review-upsert-pr` — STAGE ② of the three-stage PR flow, between `wp-start-upsert-pr` (sync from main)
 * and `wp-finish-upsert-pr` (post the PR).
 *
 * It exists because reviewing came before verifying. Under the old two-command flow the 3-point merge was
 * finalized and the build gate ran inside `wp-finish-upsert-pr` — i.e. AFTER the reviewers had already run.
 * A reviewer could therefore spend a full review on an unresolved merge, or on code that does not compile,
 * and only afterwards would the branch be checked. This command puts the verification first:
 *
 *   1. finalize + VALIDATE any in-progress 3-point merge  (moved here from finish)
 *   2. assert a clean tree                                 (meaningful now — step 1 committed the resolution)
 *   3. run the build gate                                  (on the merged, committed tree)
 *   4. scan the checklists, EXTRACT the diff, BRIEF the reviewers
 *   5. write the stage receipt, then print what to spawn + the review.json schema
 *
 * Unlike the report-only command it replaces — which always exited 0, because reporting is not gating — this
 * command CAN FAIL, at steps 1, 2 and 3. That is the point: it fails BEFORE any reviewer is spawned, so a
 * branch with an unresolved merge or a broken build costs zero reviewer tokens.
 *
 * The ordering of 1 → 2 → 3 is load-bearing. MergeEnd stages and commits the conflict resolution, so the
 * tree is clean by the time the build runs; building first would either build a dirty tree (proving nothing
 * about what ships) or refuse a tree that is legitimately mid-resolution.
 */
@injectable(bindingScopeValues.Singleton)
export class ReviewUpsertPrCommand {
    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly gitExec: GitExec,
        private readonly buildAffected: BuildAffected,
        private readonly buildArtifactGate: BuildArtifactGate,
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
        private readonly checklistScanner: ChecklistScanner,
        private readonly reviewReport: ReviewReport,
        private readonly materializer: DiffMaterializer,
        private readonly prContextWriter: PrContextWriter,
        private readonly briefingBuilder: ReviewerBriefingBuilder,
        private readonly reviewerInstructions: ReviewerInstructionsService,
        private readonly receipts: ReviewStageReceiptService,
        private readonly activeHatchReport: ActiveHatchReport,
        // Injected only to RESOLVE + RENDER refusals (see refusals()). This stage never archives a verdict.
        private readonly reviewJsonService: ReviewJsonService,
    ) {}

    async run(opts: ReviewUpsertPrOptions = new ReviewUpsertPrOptions()): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        writeTemplate(repoRoot, 'webpieces.git-workflow.md');
        writeTemplate(repoRoot, 'webpieces.review-checklists.md');
        const featureName = this.aiBranchName.getFeatureName();
        const config = loadAndValidate(repoRoot).prGate;

        const mergeValidated = await this.finalizeAnyInProgressMerge(repoRoot);
        this.gitExec.assertCleanTree(repoRoot);
        const buildPassedAt = this.runBuildGate(repoRoot);

        const scan = this.checklistScanner.scan(repoRoot, config.checklists, new ChecklistScanOptions(false, ''));  // '' — THIS command writes the context itself, after materializing
        const briefings = this.briefReviewers(repoRoot, featureName, scan, config);
        this.receipts.write(repoRoot, featureName, new ReviewStageReceipt(
            scan.basis.headSha, mergeValidated, this.buildAffected.resolveBuildCommand(repoRoot), buildPassedAt,
            briefings.map((b: ReviewerBriefing): string => b.subagent),
        ));
        this.reportActiveHatches(repoRoot);
        this.report(repoRoot, featureName, scan, briefings, opts);
    }

    /**
     * List every rule that is currently switched off in webpieces.config.json. NON-BLOCKING and printed
     * before the instruction block, because it is context for the review rather than a step in it.
     *
     * A hatch is the one config change that makes the build QUIETER, so no gate, reviewer or red check
     * will ever mention it — which is how a repo ends up with rules off for weeks that nobody chose to
     * leave off. This is the only place in the flow that says so out loud.
     */
    private reportActiveHatches(repoRoot: string): void {
        const hatches: ActiveHatch[] = this.activeHatchReport.scan(repoRoot);
        process.stdout.write(this.activeHatchReport.render(hatches));
    }

    /**
     * Validate + commit + finalize a conflict resolution, if one is in flight. MOVED here from
     * `wp-finish-upsert-pr` so that exactly one command owns merge finalization — two owners is the drift
     * failure `PrContextWriter`'s own docstring records having already happened once in this codebase.
     *
     * MergeEnd's three checks are what "did the AI do the 3-point merge right?" means concretely: no
     * conflict markers left in the scoped files, `git diff --diff-filter=U` empty, and a non-empty
     * merge-explanation.md beside every conflicted file.
     *
     * Returns true when a merge was finalized OR there was none to finalize; it throws rather than returning
     * false when validation fails, so the receipt can never record an unvalidated merge as validated.
     */
    private async finalizeAnyInProgressMerge(repoRoot: string): Promise<boolean> {
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        const marker = activeDir ? this.mergeState.readMergeMarker(activeDir) : null;
        if (!activeDir || !marker || marker.validated) return true;
        process.stdout.write('\n' + SEP + '① Validating your 3-point merge\n' + SEP + '\n');
        // pushRemote:false — finish still owns the single push.
        await this.mergeEnd.mergeEnd(
            repoRoot, 'wp-review-upsert-pr', activeDir,
            new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
            new MergeEndOptions(marker.conflictedFiles, false),
        );
        return true;
    }

    /**
     * The build gate, run BEFORE any reviewer is briefed. Returns the ISO time it passed, for the receipt —
     * which is what lets `wp-finish-upsert-pr` skip its own gate when HEAD has not moved, so moving the gate
     * earlier did not turn one build into two.
     */
    private runBuildGate(repoRoot: string): string {
        this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions(
            '🛠️  Build gate',
            'pnpm wp-review-upsert-pr',
            'Build failed — NO reviewer was briefed and no diff was extracted. Fix it, then re-run.',
            REVIEW_STAGE,
        ));
        // Repo-wide: the build must not have left anything uncommitted AND unstaged. Runs HERE, not in
        // finish, because this is the stage that ran buildCommand and is therefore holding the dirty
        // tree at the exact moment the question is answerable. Replaces the per-project
        // validate-di-graph-unchanged nx target — see BuildArtifactGate for why that one had to go.
        this.buildArtifactGate.assertBuildLeftNothingUncommitted(repoRoot);
        return new Date().toISOString();
    }

    /**
     * Extract the diff once, then write one instructions file per reviewer.
     *
     * The changed-file set and the basis both come off the SCAN rather than being recomputed, so the diff a
     * reviewer reads covers exactly the files its checklist matched against.
     */
    private briefReviewers(repoRoot: string, featureName: string, scan: ChecklistScan, config: PrGateConfig): ReviewerBriefing[] {
        if (scan.basis.unresolved) return [];
        const manifest = this.materializer.materialize(
            repoRoot, featureName, scan.basis, scan.changedFiles, config.reviewDiffExclude);
        const diffDir = this.materializer.diffDirFor(repoRoot, featureName);
        // Write pr-context.json ONCE, here — after materializing, so `diffDir` is populated on the first
        // write. The scan deliberately did not write it (ChecklistScanOptions.contextStage === ''); it used
        // to, which meant this command wrote the same file twice, the first time with an empty diffDir.
        // `scan.changedFiles` is passed through so the context is not recomputed from a second git call.
        scan.context = this.prContextWriter.ensure(
            repoRoot, featureName, scan.basis, 'stage2-review', scan.changedFiles, diffDir);
        const briefings = this.briefingBuilder.build(repoRoot, scan, manifest, diffDir, config);
        const dir = this.reviewerInstructions.instructionsDirFor(repoRoot, featureName);
        fs.rmSync(dir, { recursive: true, force: true }); // stale instructions read as current are worse than none
        fs.mkdirSync(dir, { recursive: true });
        for (const b of briefings) {
            fs.writeFileSync(this.reviewerInstructions.pathFor(repoRoot, featureName, b.subagent),
                this.reviewerInstructions.render(b));
        }
        return briefings;
    }

    /**
     * What the AI must do next — rendered by `ReviewReport`, which owns the ordering.
     *
     * The rendering moved OUT of this command so the ordering could be asserted on as a string. It had a
     * real bug: the zero-checklist notice signed off with "Carry on and run: pnpm wp-finish-upsert-pr"
     * while the block right beneath it said to write review.json first. An agent that reads top to bottom
     * obeyed the first line and posted a PR with no review at all.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private report(
        repoRoot: string, featureName: string, scan: ChecklistScan, briefings: readonly ReviewerBriefing[],
        opts: ReviewUpsertPrOptions,
    ): void {
        const input = new ReviewReportInput(repoRoot, featureName, scan.reviewPath);
        input.definedCount = scan.defined.length;
        input.applicableCount = scan.applicable.length;
        input.reviewed = scan.reviewed.slice();
        input.formatErrors = scan.formatErrors.slice();
        input.briefings = briefings.slice();
        input.refused = this.refusals(scan);
        input.skipOptional = opts.skipOptional;
        process.stdout.write(this.reviewReport.render(input));
    }

    /**
     * The applicable checklists that ALREADY ANSWERED and refused, each with its refusal rendered by the ONE
     * renderer `wp-finish-upsert-pr` also uses.
     *
     * Stage ② had the identical defect finish did: a refused checklist has no passing verdict, so it is not
     * in `scan.reviewed`, so it was printed as an ordinary owed reviewer and re-instructed word for word —
     * and an agent that obeys spawns it against unchanged code, gets the same refusal, and loops one stage
     * earlier than the loop that was reported.
     *
     * NO archive path is passed, deliberately, and this stage moves nothing. Retiring a verdict is finish's
     * act on the refusal it is actually enforcing; doing it here would delete the live verdict of a branch
     * that has not even been asked to finish yet, and `refusalError`'s un-archived wording — "set an override
     * in review-<id>.json" — is only correct while that file is still there, which here it is.
     */
    private refusals(scan: ChecklistScan): RefusedReviewer[] {
        const refused = this.reviewJsonService.refusedChecklists(scan.applicable, scan.results);
        return refused.map((req: RequiredChecklist): RefusedReviewer => new RefusedReviewer(
            req.id, this.reviewJsonService.refusalError(req, this.reviewJsonService.resolveVerdict(req, scan.results))));
    }
}
