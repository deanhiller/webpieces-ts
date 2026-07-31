import * as fs from 'fs';
import {
    loadAndValidate, writeTemplate, PrGateConfig, RepoRootFinder,
    ReviewerBriefing, ReviewerInstructionsService,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { BuildArtifactGate } from '../workflow/build-artifact-gate';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { DiffMaterializer } from '../workflow/diff-materializer';
import { GitExec } from '../workflow/git-exec';
import { MergeContext } from '../workflow/merge-start';
import { MergeEnd, MergeEndOptions } from '../workflow/merge-end';
import { MergeState } from '../workflow/merge-state';
import { PrContextWriter } from '../workflow/pr-context-writer';
import { ReviewerBriefingBuilder } from '../workflow/reviewer-briefing-builder';
import { ReviewReport, ReviewReportInput } from '../workflow/review-report';
import { ReviewStageReceipt, ReviewStageReceiptService } from '../workflow/review-stage-receipt';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

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
    ) {}

    async run(): Promise<void> {
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
        this.report(repoRoot, featureName, scan, briefings);
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
    private report(repoRoot: string, featureName: string, scan: ChecklistScan, briefings: readonly ReviewerBriefing[]): void {
        const input = new ReviewReportInput(repoRoot, featureName, scan.reviewPath);
        input.definedCount = scan.defined.length;
        input.applicableCount = scan.applicable.length;
        input.reviewed = scan.reviewed.slice();
        input.formatErrors = scan.formatErrors.slice();
        input.briefings = briefings.slice();
        process.stdout.write(this.reviewReport.render(input));
    }
}
