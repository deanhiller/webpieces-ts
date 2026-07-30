import * as fs from 'fs';
import * as path from 'path';
import {
    loadAndValidate, reviewJsonSchemaHint, writeTemplate, PrGateConfig, RepoRootFinder,
    ChecklistInstructionsService, RequiredChecklist, ReviewerBriefing, ReviewerInstructionsService, toError,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { ChecklistNotice } from '../workflow/checklist-notice';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from '../workflow/checklist-scanner';
import { DiffManifest, DiffManifestEntry, DiffMaterializer } from '../workflow/diff-materializer';
import { GitExec } from '../workflow/git-exec';
import { MergeContext } from '../workflow/merge-start';
import { MergeEnd, MergeEndOptions } from '../workflow/merge-end';
import { MergeState } from '../workflow/merge-state';
import { ReviewerBriefingBuilder } from '../workflow/reviewer-briefing-builder';
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
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
        private readonly checklistScanner: ChecklistScanner,
        private readonly checklistNotice: ChecklistNotice,
        private readonly instructions: ChecklistInstructionsService,
        private readonly materializer: DiffMaterializer,
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

        const scan = this.checklistScanner.scan(repoRoot, config.checklists, new ChecklistScanOptions(false));
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
            '🛠️  Build gate (pre-review)',
            'pnpm wp-review-upsert-pr',
            'Build failed — NO reviewer was briefed and no diff was extracted. Fix it, then re-run.',
        ));
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
        // Re-point pr-context.json at the extracted diff now that there is one — the scan wrote it before
        // materialization, so without this the reviewers' own context file would not mention the diff dir.
        this.rewritePrContext(repoRoot, featureName, diffDir);
        const briefings = this.briefingBuilder.build(repoRoot, scan, manifest, diffDir, config);
        const dir = this.reviewerInstructions.instructionsDirFor(repoRoot, featureName);
        fs.rmSync(dir, { recursive: true, force: true }); // stale instructions read as current are worse than none
        fs.mkdirSync(dir, { recursive: true });
        for (const b of briefings) {
            fs.writeFileSync(this.reviewerInstructions.pathFor(repoRoot, featureName, b.subagent),
                this.reviewerInstructions.render(b));
        }
        this.printDiffSummary(manifest, diffDir);
        return briefings;
    }

    // pr-context.json is written by the scan (before the diff exists). Patch in the dir rather than
    // re-deriving the whole context: re-deriving means a second basis resolution, which is the drift.
    private rewritePrContext(repoRoot: string, featureName: string, diffDir: string): void {
        const p = path.join(repoRoot, '.webpieces', 'pr-review', featureName, 'pr-context.json');
        if (!fs.existsSync(p)) return;
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: an unreadable context is left as-is, never fatal
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-any-unknown -- opaque parsed JSON, one key added
            const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
            raw['diffDir'] = diffDir;
            fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
        } catch (err: unknown) {
            const error = toError(err);
            void error; // leave the file as-is — the instructions files carry the same paths directly
        }
    }

    private printDiffSummary(manifest: DiffManifest, diffDir: string): void {
        process.stdout.write('\n' + SEP + '② Diff extracted for the reviewers\n' + SEP + '\n');
        process.stdout.write(`   ${manifest.entries.length} file(s) → ${diffDir}\n`);
        if (manifest.excluded.length > 0) {
            process.stdout.write(`   ${manifest.excluded.length} excluded by pr-gate.reviewDiffExclude (stubbed, still matched)\n`);
        }
        const truncated = manifest.entries.filter((e: DiffManifestEntry): boolean => e.truncated).length;
        if (truncated > 0) process.stdout.write(`   ${truncated} truncated at the per-file cap (each says so in its footer)\n`);
    }

    /** What the AI must do next: spawn each reviewer, then write review.json. */
    private report(repoRoot: string, featureName: string, scan: ChecklistScan, briefings: readonly ReviewerBriefing[]): void {
        process.stdout.write('\n' + SEP + '③ Review, then finish\n' + SEP + '\n');
        if (scan.applicable.length === 0) {
            process.stdout.write(this.checklistNotice.build(scan.defined.length, 'wp-finish-upsert-pr'));
        } else {
            process.stdout.write(this.spawnBlocks(repoRoot, featureName, scan, briefings));
        }
        process.stdout.write(
            `\nThen review your own changes and\n${reviewJsonSchemaHint(scan.reviewPath)}\n\n` +
            `Finally run:  pnpm wp-finish-upsert-pr\n` +
            `(The build gate is already green for this commit — finish reuses it unless HEAD moves.)\n\n`);
    }

    /**
     * One copy-paste block per owed reviewer. The prompt is deliberately a POINTER and nothing else: the
     * generated instructions file is the contract, so anything restated here is a second copy that can go
     * stale — which is exactly how a removed `success` field outlived its own removal in print.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private spawnBlocks(repoRoot: string, featureName: string, scan: ChecklistScan, briefings: readonly ReviewerBriefing[]): string {
        const reviewedIds = new Set(scan.reviewed.map((r: RequiredChecklist): string => r.id));
        const owed = briefings.filter((b: ReviewerBriefing): boolean => !reviewedIds.has(b.checklistId));
        const lines: string[] = [];
        for (const r of scan.reviewed) {
            lines.push(`  ✓ ${r.subagent} — already reviewed on this branch (reusing its review-${r.id}.json)`);
        }
        // A verdict file that EXISTS but is unreadable as a verdict is called out here. Without it this
        // reports the checklist as simply owed, and the AI re-runs a reviewer that already ran instead of
        // correcting the file sitting right there.
        for (const e of scan.formatErrors) lines.push(`  ⛔ ${e}`);
        if (owed.length === 0) {
            lines.push('', '✅ Every checklist that applies is already reviewed — nothing to spawn.');
            return lines.join('\n') + '\n';
        }
        lines.push('',
            `Spawn these ${owed.length} reviewer subagent(s) — a SEPARATE one each. You may NOT review your own`,
            'work, and you may NOT write a reviewer\'s verdict file on its behalf.',
            '');
        for (const b of owed) {
            lines.push(`  ▶ ${b.subagent} — ${this.why(b)}`);
            lines.push(`      subagent_type: ${b.subagent}`);
            lines.push('      prompt:        Read your instructions file FIRST and follow it exactly:');
            lines.push(`                     ${this.reviewerInstructions.pathFor(repoRoot, featureName, b.subagent)}`);
            lines.push('');
        }
        return lines.join('\n');
    }

    // Why this one is in scope. A patternless checklist is NOT "matched" — it always runs, over the whole
    // diff, and saying so is what tells a repo its checklist is firing on docs-only PRs by design.
    private why(b: ReviewerBriefing): string {
        if (b.matchedPatterns.length === 0) {
            return `ALWAYS RUNS (no "patterns" configured), whole diff in scope — ${b.myFiles.length} file(s)`;
        }
        return `${b.myFiles.length} file(s) matched ${b.matchedPatterns.map((p: string): string => `"${p}"`).join(', ')}`;
    }
}
