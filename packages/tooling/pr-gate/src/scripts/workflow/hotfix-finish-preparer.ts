import { spawnSync } from 'child_process';
import { BranchIdentity, InformAiError, PrSummary, ReviewJsonService, loadAndValidate, summaryJsonPath } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { BuildAffected, BuildGateOptions } from './build-affected';
import { BuildArtifactGate } from './build-artifact-gate';
import { FINISH_STAGE } from './build-gate-log';
import { ChecklistScan, ChecklistScanOptions, ChecklistScanner } from './checklist-scanner';
import { DiffMaterializer } from './diff-materializer';
import { GitExec } from './git-exec';
import { MergeContext } from './merge-start';
import { MergeEnd, MergeEndOptions } from './merge-end';
import { MergeState } from './merge-state';
import { PrContextWriter } from './pr-context-writer';
import { ProvenanceEnforcer, ProvenanceReport } from './provenance-enforcer';

export class HotfixFinishState {
    constructor(
        readonly featureName: string,
        readonly currentBranch: string,
        readonly review: PrSummary,
        readonly scan: ChecklistScan,
        readonly provenance: ProvenanceReport,
    ) {}
}

/** Validates and builds the emergency flow before FinishUpsertPrCommand publishes anything. */
@injectable(bindingScopeValues.Singleton)
export class HotfixFinishPreparer {
    constructor(
        private readonly branchIdentity: BranchIdentity,
        private readonly aiBranchName: AiBranchName,
        private readonly gitExec: GitExec,
        private readonly reviewJsonService: ReviewJsonService,
        private readonly buildAffected: BuildAffected,
        private readonly buildArtifactGate: BuildArtifactGate,
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
        private readonly checklistScanner: ChecklistScanner,
        private readonly materializer: DiffMaterializer,
        private readonly prContextWriter: PrContextWriter,
        private readonly provenanceEnforcer: ProvenanceEnforcer,
    ) {}

    async prepare(repoRoot: string): Promise<HotfixFinishState> {
        await this.finalizeMerge(repoRoot);
        this.gitExec.assertCleanTree(repoRoot);
        const featureName = this.aiBranchName.getFeatureName();
        const review = this.reviewJsonService.loadSummaryJson(summaryJsonPath(repoRoot, featureName), []);
        const headBefore = this.gitOut(repoRoot, ['rev-parse', 'HEAD']);
        await this.buildAffected.runBuildGate(repoRoot, new BuildGateOptions('🛠️  Hotfix build gate (build + test only)', 'pnpm wp-finish-upsert-pr', 'Hotfix build failed — no PR created/updated.', FINISH_STAGE));
        this.buildArtifactGate.assertBuildLeftNothingUncommitted(repoRoot);
        this.gitExec.assertCleanTree(repoRoot);
        if (headBefore === '' || this.gitOut(repoRoot, ['rev-parse', 'HEAD']) !== headBefore) {
            throw new InformAiError('Hotfix HEAD changed while compilation/tests were running. Re-run pnpm wp-finish-upsert-pr so the build receipt covers the exact commit pushed.');
        }
        const config = loadAndValidate(repoRoot).prGate;
        const scan = this.checklistScanner.scan(repoRoot, config.checklists, new ChecklistScanOptions(config.maxReviewerRounds, false, ''));
        if (!scan.basis.unresolved) {
            this.materializer.materialize(repoRoot, featureName, scan.basis, scan.changedFiles, config.reviewDiffExclude);
            this.prContextWriter.ensure(repoRoot, featureName, scan.basis, 'stage3-hotfix', scan.changedFiles, this.materializer.diffDirFor(repoRoot, featureName));
        }
        const currentBranch = this.branchIdentity.current();
        const provenance = this.provenanceEnforcer.enforce([], currentBranch, repoRoot, config);
        return new HotfixFinishState(featureName, currentBranch, review, scan, provenance);
    }

    private async finalizeMerge(repoRoot: string): Promise<void> {
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        const marker = activeDir ? this.mergeState.readMergeMarker(activeDir) : null;
        if (!activeDir || !marker || marker.validated) return;
        await this.mergeEnd.mergeEnd(repoRoot, 'wp-finish-upsert-pr', activeDir, new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber), new MergeEndOptions(marker.conflictedFiles, false));
    }

    private gitOut(repoRoot: string, args: string[]): string {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        return result.status === 0 ? (result.stdout ?? '').trim() : '';
    }
}
