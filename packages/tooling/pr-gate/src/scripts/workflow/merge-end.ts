import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    MERGE_EXPLANATION_FILE, stampCleanMainSyncStatus, CliExitError,
    MutationVerb, BranchMutationEvent, logBranchMutation,
} from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { BranchNaming } from './branch-naming';
import { CleanTmp } from './cleanTmp';
import { GitExec } from './git-exec';
import { MergeContext } from './merge-start';
import { MergeState } from './merge-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// merge-END: the second half of the 3-point squash-merge lifecycle, symmetric with merge-START. Given
// the branch context, it (optionally) validates + commits the AI's conflict resolution, then ALWAYS
// finalizes — force-pushes `<branch>Squash` to the stable feature branch and renames it BACK to that
// same feature name (local == remote == PR head), stamps a clean main-sync status, clears the marker,
// and sweeps stale tmp. RunUpdate (clean path / validated resume), wp-finish-update, and
// wp-finish-upsert-pr (conflict resolution) all call THIS, so finalization happens in exactly one place.
@provideSingleton()
@injectable()
export class MergeEnd {
    constructor(
        private readonly branchNaming: BranchNaming,
        private readonly cleanTmpService: CleanTmp,
        private readonly gitExec: GitExec,
        private readonly mergeState: MergeState,
    ) {}

    /**
     * Complete a 3-point squash merge. `conflictedFiles` non-null means a conflict was resolved by the
     * AI and must be validated + committed before finalizing; null means a clean merge that merge-START
     * already committed (finalize only). Either way the merge ends fully finalized on the feature branch.
     */
    async mergeEnd(
        repoRoot: string, verb: MutationVerb, mergeDir: string, ctx: MergeContext, conflictedFiles: string[] | null,
    ): Promise<void> {
        if (conflictedFiles !== null) {
            process.stdout.write('\n' + SEP + '🔎 Validating Merge Resolution\n' + SEP + '\n');
            this.validateResolution(repoRoot, mergeDir, conflictedFiles);
            // Stage the AI's resolved conflicts, but NEVER sweep untracked files into the squash commit.
            // Fail on untracked so the AI commits or deletes them explicitly; then `git add -u` stages
            // tracked resolutions only.
            this.gitExec.assertNoUntracked(repoRoot);
            this.gitExec.runGitChecked(['add', '-u'], 'Failed to stage resolved files');

            const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
            if (!nothingStaged) {
                this.gitExec.runGitChecked(
                    ['commit', '-m', `Squash merge of ${ctx.currentBranch} (conflicts resolved)`],
                    'Failed to commit resolved merge',
                );
            }
            fs.writeFileSync(path.join(mergeDir, 'conflicts-resolved'), '');
            process.stdout.write('\n✅ Merge validated and committed.\n');
        }

        // A marker in THIS run dir means the sync hit conflicts (marker is written only on hand-back).
        // Read it BEFORE clearMergeMarker so finalize knows whether to keep the pre-merge snapshot.
        const hadConflict = this.mergeState.readMergeMarker(mergeDir) !== null;
        this.finalizeBranch(repoRoot, verb, ctx, hadConflict);
        this.mergeState.clearMergeMarker(mergeDir);
        await this.cleanTmpService.cleanTmp();
    }

    // Validate the AI's resolution of the conflicted files. Throws CliExitError with a fix instruction
    // on any failure; returns only when all three checks pass.
    private validateResolution(repoRoot: string, mergeDir: string, conflictedFiles: string[]): void {
        // 1. Scoped conflict-marker scan (only the conflicted files — O(conflicts), not O(repo)).
        const scan = this.mergeState.scanConflictMarkers(repoRoot, conflictedFiles);
        if (!scan.clean) {
            throw new CliExitError(1,
                '❌ Unresolved conflict markers (<<<<<<< / ======= / >>>>>>>) remain in:\n' +
                scan.filesWithMarkers.map((file: string): string => `  - ${file}`).join('\n') +
                '\n\nResolve them, then re-run: pnpm wp-finish-upsert-pr',
            );
        }

        // 2. Ensure git itself has no remaining unmerged entries.
        const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
        if (unmerged !== '') {
            throw new CliExitError(1,
                '❌ Git still reports unmerged files:\n' + unmerged +
                '\n\nResolve and `git add` them, then re-run: pnpm wp-finish-upsert-pr',
            );
        }
        process.stdout.write('✅ No conflict markers in resolved files.\n');

        // 3. Explanation check — every conflicted file must have a non-empty merge-explanation.md in its
        // per-file context dir, proving the AI deliberately 3-point merged it (and recording how).
        const explanations = this.mergeState.scanMergeExplanations(mergeDir, conflictedFiles);
        if (!explanations.clean) {
            const missing = explanations.filesWithMarkers
                .map((file: string): string => `  - ${file}\n      → ${path.join(this.mergeState.perFileContextDir(mergeDir, file), MERGE_EXPLANATION_FILE)}`)
                .join('\n');
            throw new CliExitError(1,
                `❌ Missing/empty merge explanation (${MERGE_EXPLANATION_FILE}) for:\n` +
                missing +
                '\n\nWrite a few sentences on how you resolved each (which side, what you combined, why),\n' +
                'then re-run: pnpm wp-finish-upsert-pr',
            );
        }
        process.stdout.write('✅ Merge explanations present for all resolved files.\n');
    }

    private localBranchExists(name: string): boolean {
        return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
    }

    // Force-push the squash branch to the stable feature branch (where the single PR lives), then RENAME
    // the local squash branch back to that SAME feature name. On a CLEAN sync the pre-merge snapshot is
    // disposable, so it's deleted at the very end; a CONFLICT sync keeps it.
    private finalizeBranch(repoRoot: string, verb: MutationVerb, ctx: MergeContext, hadConflict: boolean): void {
        process.stdout.write('\n' + SEP + '🗑️  Finalizing\n' + SEP + '\n');
        const base = this.branchNaming.baseBranchName(ctx.currentBranch);
        this.gitExec.runGitChecked(['branch', '-D', ctx.currentBranch], 'Failed to delete old feature branch');

        const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', base]).status === 0;
        if (remoteExists) {
            process.stdout.write(ctx.prNumber ? `Updating PR #${ctx.prNumber} (force-with-lease)...\n` : 'Updating remote branch (force-with-lease)...\n');
            this.gitExec.runGitChecked(['push', '-u', '--force-with-lease', 'origin', `${ctx.squashBranch}:${base}`], 'Failed to push to origin');
        } else {
            process.stdout.write('No remote branch — local only.\n');
        }
        this.gitExec.runGitChecked(['checkout', ctx.squashBranch], 'Failed to checkout squash branch');
        // Free the rename target: `base` is normally the branch we just deleted, but a backward-compat
        // sync from a leftover `…wpN` can leave a separate stale `base` lingering — drop it too.
        if (base !== ctx.currentBranch && this.localBranchExists(base)) {
            this.gitExec.runGitChecked(['branch', '-D', base], 'Failed to delete stale base branch');
        }
        this.gitExec.runGitChecked(['branch', '-m', base], 'Failed to rename squash branch to the feature name');
        const renameEvent = new BranchMutationEvent(verb, 'RENAME');
        renameEvent.fromBranch = ctx.currentBranch;
        renameEvent.toBranch = base;
        logBranchMutation(repoRoot, renameEvent);

        // Branch now contains origin/main — stamp a clean main-sync status so the feature-branch-guard
        // unblocks edits immediately (no wait for the async refresher).
        stampCleanMainSyncStatus(execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim());

        // Clean sync → the pre-merge snapshot was never needed; delete it LAST. Conflict sync → keep it.
        const backupKept = hadConflict;
        if (!backupKept && this.localBranchExists(ctx.backupBranch)) {
            this.gitExec.runGitChecked(['branch', '-D', ctx.backupBranch], 'Failed to delete clean-merge backup');
        }

        const finalizeEvent = new BranchMutationEvent(verb, 'FINALIZE');
        finalizeEvent.fromBranch = ctx.currentBranch;
        finalizeEvent.toBranch = base;
        finalizeEvent.outcome = 'finalized';
        finalizeEvent.artifacts = [backupKept ? `backup=${ctx.backupBranch}` : `backupDeleted=${ctx.backupBranch}`, `remotePR=${base}`];
        logBranchMutation(repoRoot, finalizeEvent);

        this.printSyncRecap(base, ctx.backupBranch, ctx.prNumber, remoteExists, backupKept);
    }

    // The explicit, numbered "here is exactly what I did" recap the AI (and human) reads after a sync.
    private printSyncRecap(feature: string, backupBranch: string, prNumber: string, pushed: boolean, backupKept: boolean): void {
        const remoteLine = pushed
            ? `landed back on  ${feature}   (== origin/${feature}${prNumber ? ` == PR #${prNumber}` : ''} — names match)`
            : `landed back on  ${feature}   (local only — no remote branch yet)`;
        const step1 = backupKept
            ? `snapshotted your pre-merge state → ${backupBranch} (kept — this merge had conflicts)`
            : `snapshotted your pre-merge state → ${backupBranch} (auto-removed — clean merge, no undo needed)`;
        const trailer = backupKept
            ? `   Pre-merge snapshot trail:  git branch --list '${feature}PreMerge*'\n` +
              `   Its conflict context lives in the paired  merge-<n>/  folder under .webpieces/merge-info/\n` +
              `   Prune this run's snapshot when safe:  git branch -D ${backupBranch}\n\n`
            : '\n';
        process.stdout.write(
            '\n' + SEP + '✅ Sync complete — here is exactly what I did\n' + SEP + '\n' +
            `   1. ${step1}\n` +
            `   2. pulled origin/main\n` +
            `   3. squash-merged your work onto main\n` +
            `   4. ${remoteLine}\n\n` +
            trailer,
        );
    }
}
