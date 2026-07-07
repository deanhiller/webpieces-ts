import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    MERGE_EXPLANATION_FILE, stampCleanMainSyncStatus, CliExitError,
    MutationVerb, BranchMutationEvent, logBranchMutation,
} from '@webpieces/rules-config';
import { baseBranchName } from './branch-naming';
import { cleanTmp } from './cleanTmp';
import { assertNoUntracked, runGitChecked } from './git-exec';
import { MergeContext } from './merge-start';
import { clearMergeMarker, perFileContextDir, scanConflictMarkers, scanMergeExplanations } from './merge-state';

// merge-END: the second half of the 3-point squash-merge lifecycle, symmetric with merge-START. Given
// the branch context, it (optionally) validates + commits the AI's conflict resolution, then ALWAYS
// finalizes the merge — force-pushes `<branch>Squash` to the stable feature branch and renames it
// BACK to that same feature name (local == remote == PR head), stamps a clean main-sync status,
// clears the marker and sweeps stale tmp. The shared runUpdateFromMain (clean path / validated resume), wp-update-end, and
// wp-finish-upsert-pr (conflict resolution) all call THIS, so finalization happens in exactly one
// place and the conflict path can no longer post a PR from the un-swapped squash branch.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Validate the AI's resolution of the conflicted files — the part of the process the AI owns
// (branch creation/finalization is the script's job, so it is not re-checked here). Throws
// CliExitError with a fix instruction on any failure; returns only when all three checks pass.
function validateResolution(repoRoot: string, mergeDir: string, conflictedFiles: string[]): void {
    // 1. Scoped conflict-marker scan (only the conflicted files — O(conflicts), not O(repo)).
    const scan = scanConflictMarkers(repoRoot, conflictedFiles);
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

    // 3. Explanation check — every conflicted file must have a non-empty merge-explanation.md in
    // its per-file context dir, proving the AI deliberately 3-point merged it (and recording how)
    // rather than blindly taking one side. A sidecar file works for any type, incl. JSON/deletes.
    const explanations = scanMergeExplanations(mergeDir, conflictedFiles);
    if (!explanations.clean) {
        const missing = explanations.filesWithMarkers
            .map((file: string): string => `  - ${file}\n      → ${path.join(perFileContextDir(mergeDir, file), MERGE_EXPLANATION_FILE)}`)
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

function localBranchExists(name: string): boolean {
    return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
}

// Force-push the squash branch to the stable feature branch (where the single PR lives), then RENAME
// the local squash branch back to that SAME feature name — so the local branch, the remote branch,
// and the PR head are all one name (no `wpN` divergence). The pre-merge snapshot is preserved as a
// numbered PreMerge trail. Ends with an explicit "here is exactly what I did" recap for the AI/human.
function finalizeBranch(repoRoot: string, verb: MutationVerb, ctx: MergeContext): void {
    process.stdout.write('\n' + SEP + '🗑️  Finalizing\n' + SEP + '\n');
    const base = baseBranchName(ctx.currentBranch);
    runGitChecked(['branch', '-D', ctx.currentBranch], 'Failed to delete old feature branch');

    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', base]).status === 0;
    if (remoteExists) {
        process.stdout.write(ctx.prNumber ? `Updating PR #${ctx.prNumber} (force-with-lease)...\n` : 'Updating remote branch (force-with-lease)...\n');
        runGitChecked(['push', '-u', '--force-with-lease', 'origin', `${ctx.squashBranch}:${base}`], 'Failed to push to origin');
    } else {
        process.stdout.write('No remote branch — local only.\n');
    }
    runGitChecked(['checkout', ctx.squashBranch], 'Failed to checkout squash branch');
    // Free the rename target: `base` is normally the branch we just deleted (ctx.currentBranch), but on
    // a backward-compat sync from a leftover `…wpN` a separate stale `base` can linger — drop it too.
    if (base !== ctx.currentBranch && localBranchExists(base)) {
        runGitChecked(['branch', '-D', base], 'Failed to delete stale base branch');
    }
    runGitChecked(['branch', '-m', base], 'Failed to rename squash branch to the feature name');
    const renameEvent = new BranchMutationEvent(verb, 'RENAME');
    renameEvent.fromBranch = ctx.currentBranch;
    renameEvent.toBranch = base;
    logBranchMutation(repoRoot, renameEvent);

    // Branch now contains origin/main — stamp a clean main-sync status so the feature-branch-guard
    // unblocks edits immediately (no wait for the async refresher).
    stampCleanMainSyncStatus(execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim());

    const finalizeEvent = new BranchMutationEvent(verb, 'FINALIZE');
    finalizeEvent.fromBranch = ctx.currentBranch;
    finalizeEvent.toBranch = base;
    finalizeEvent.outcome = 'finalized';
    finalizeEvent.artifacts = [`backup=${ctx.backupBranch}`, `remotePR=${base}`];
    logBranchMutation(repoRoot, finalizeEvent);

    printSyncRecap(base, ctx.backupBranch, ctx.prNumber, remoteExists);
}

// The explicit, numbered "here is exactly what I did" recap the AI (and human) reads after a sync.
// The whole point of the branch-name change is that step 4 can now say "same name as remote/PR" —
// there is no confusing local-vs-remote divergence left to explain.
function printSyncRecap(feature: string, backupBranch: string, prNumber: string, pushed: boolean): void {
    const remoteLine = pushed
        ? `landed back on  ${feature}   (== origin/${feature}${prNumber ? ` == PR #${prNumber}` : ''} — names match)`
        : `landed back on  ${feature}   (local only — no remote branch yet)`;
    process.stdout.write(
        '\n' + SEP + '✅ Sync complete — here is exactly what I did\n' + SEP + '\n' +
        `   1. snapshotted your pre-merge state → ${backupBranch}\n` +
        `   2. pulled origin/main\n` +
        `   3. squash-merged your work onto main\n` +
        `   4. ${remoteLine}\n\n` +
        `   Pre-merge snapshot trail:  git branch --list '${feature}PreMerge*'\n` +
        `   Prune this run's snapshot when safe:  git branch -D ${backupBranch}\n\n`,
    );
}

/**
 * Complete a 3-point squash merge. `conflictedFiles` non-null means a conflict was resolved by the AI
 * and must be validated + committed before finalizing; null means a clean merge that merge-START
 * already committed (finalize only). Either way the merge ends fully finalized on the feature branch.
 */
export async function mergeEnd(
    repoRoot: string, verb: MutationVerb, mergeDir: string, ctx: MergeContext, conflictedFiles: string[] | null,
): Promise<void> {
    if (conflictedFiles !== null) {
        process.stdout.write('\n' + SEP + '🔎 Validating Merge Resolution\n' + SEP + '\n');
        validateResolution(repoRoot, mergeDir, conflictedFiles);
        // Stage the AI's resolved conflicts, but NEVER sweep untracked files into the squash commit
        // (a blanket `git add -A` once swept a stale untracked dir in). Fail on untracked so the AI
        // commits or deletes them explicitly; then `git add -u` stages tracked resolutions only.
        assertNoUntracked(repoRoot);
        runGitChecked(['add', '-u'], 'Failed to stage resolved files');

        const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
        if (!nothingStaged) {
            runGitChecked(
                ['commit', '-m', `Squash merge of ${ctx.currentBranch} (conflicts resolved)`],
                'Failed to commit resolved merge',
            );
        }
        fs.writeFileSync(path.join(mergeDir, 'conflicts-resolved'), '');
        process.stdout.write('\n✅ Merge validated and committed.\n');
    }

    finalizeBranch(repoRoot, verb, ctx);
    clearMergeMarker(mergeDir);
    await cleanTmp();
}
