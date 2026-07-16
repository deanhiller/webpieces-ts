import { CliExitError, RepoRootFinder } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { AiBranchName } from '../workflow/git-readAiBranchName';
import { MergeState } from '../workflow/merge-state';
import { MergeEnd } from '../workflow/merge-end';
import { MergeContext } from '../workflow/merge-start';

// wp-finish-update — the finalize half of the 3-point squash-merge lifecycle. Run AFTER wp-start-update
// handed back conflicts and you resolved them. Given an in-progress marker it validates + commits the
// AI's resolution (when not yet validated) and ALWAYS finalizes the branch swap. It does NOT run the
// build gate / dashboard / PR — that is wp-finish-upsert-pr. Refuses when no merge is in progress.
@injectable(bindingScopeValues.Singleton)
export class FinishUpdateCommand {
    constructor(
        private readonly repoRootFinder: RepoRootFinder,
        private readonly aiBranchName: AiBranchName,
        private readonly mergeState: MergeState,
        private readonly mergeEnd: MergeEnd,
    ) {}

    async run(): Promise<void> {
        const repoRoot = this.repoRootFinder.resolveRepoRoot(process.cwd());
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());

        // The in-progress merge is the `merge-<n>/` run dir holding a marker.
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        const marker = activeDir ? this.mergeState.readMergeMarker(activeDir) : null;
        if (!activeDir || !marker) {
            throw new CliExitError(1,
                '❌ No merge in progress (no marker) — nothing to finalize.\n' +
                'Start one with:  pnpm wp-start-update  (a clean update finalizes itself).',
            );
        }

        // Not yet validated => a conflict resolution the AI owns, so validate + commit it first;
        // already validated => clean merge (or previously validated) => finalize only.
        const conflictedFiles = marker.validated ? null : marker.conflictedFiles;
        await this.mergeEnd.mergeEnd(
            repoRoot, 'wp-finish-update', activeDir,
            new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
            conflictedFiles,
        );
        process.stdout.write('\n✅ Merge finalized on ' + marker.currentBranch + '.\n');
    }
}
