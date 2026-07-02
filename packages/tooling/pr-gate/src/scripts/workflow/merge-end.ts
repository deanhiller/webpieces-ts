import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MERGE_EXPLANATION_FILE, stampCleanMainSyncStatus } from '@webpieces/rules-config';
import { baseBranchName, nextBranchName } from './branch-naming';
import { main as cleanTmp } from './cleanTmp';
import { assertNoUntracked, runGitChecked } from './git-exec';
import { MergeContext } from './merge-start';
import { clearMergeMarker, perFileContextDir, scanConflictMarkers, scanMergeExplanations } from './merge-state';

// merge-END: the second half of the 3-point squash-merge lifecycle, symmetric with merge-START. Given
// the branch context, it (optionally) validates + commits the AI's conflict resolution, then ALWAYS
// finalizes the merge — promotes `<branch>Squash` to the next numbered generation (base → base2),
// force-pushes to the stable base branch, stamps a clean main-sync status, clears the marker and
// sweeps stale tmp. Both wp-git-update (clean path /
// validated resume) and wp-finish-upsert-pr (conflict resolution) call THIS, so finalization happens
// in exactly one place and the conflict path can no longer post a PR from the un-swapped squash branch.

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

// Validate the AI's resolution of the conflicted files — the part of the process the AI owns
// (branch creation/finalization is the script's job, so it is not re-checked here). Exits the
// process with a fix instruction on any failure; returns only when all three checks pass.
function validateResolution(repoRoot: string, mergeDir: string, conflictedFiles: string[]): void {
    // 1. Scoped conflict-marker scan (only the conflicted files — O(conflicts), not O(repo)).
    const scan = scanConflictMarkers(repoRoot, conflictedFiles);
    if (!scan.clean) {
        process.stderr.write('❌ Unresolved conflict markers (<<<<<<< / ======= / >>>>>>>) remain in:\n');
        for (const file of scan.filesWithMarkers) process.stderr.write(`  - ${file}\n`);
        process.stderr.write('\nResolve them, then re-run: pnpm wp-finish-upsert-pr\n');
        process.exit(1);
    }

    // 2. Ensure git itself has no remaining unmerged entries.
    const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    if (unmerged !== '') {
        process.stderr.write('❌ Git still reports unmerged files:\n' + unmerged + '\n');
        process.stderr.write('\nResolve and `git add` them, then re-run: pnpm wp-finish-upsert-pr\n');
        process.exit(1);
    }
    process.stdout.write('✅ No conflict markers in resolved files.\n');

    // 3. Explanation check — every conflicted file must have a non-empty merge-explanation.md in
    // its per-file context dir, proving the AI deliberately 3-point merged it (and recording how)
    // rather than blindly taking one side. A sidecar file works for any type, incl. JSON/deletes.
    const explanations = scanMergeExplanations(mergeDir, conflictedFiles);
    if (!explanations.clean) {
        process.stderr.write(`❌ Missing/empty merge explanation (${MERGE_EXPLANATION_FILE}) for:\n`);
        for (const file of explanations.filesWithMarkers) {
            process.stderr.write(`  - ${file}\n      → ${path.join(perFileContextDir(mergeDir, file), MERGE_EXPLANATION_FILE)}\n`);
        }
        process.stderr.write(
            '\nWrite a few sentences on how you resolved each (which side, what you combined, why),\n' +
            'then re-run: pnpm wp-finish-upsert-pr\n',
        );
        process.exit(1);
    }
    process.stdout.write('✅ Merge explanations present for all resolved files.\n');
}

// Promote the squash branch to the NEXT numbered generation, force-push to the stable base
// branch (where the single PR lives), and stamp clean main-sync. The local branch numbers up
// (base → base2 → base3) so the generation is visible; the remote/PR name stays `base`.
function finalizeBranch(ctx: MergeContext): void {
    process.stdout.write('\n' + SEP + '🗑️  Finalizing\n' + SEP + '\n');
    const base = baseBranchName(ctx.currentBranch);
    const next = nextBranchName(ctx.currentBranch);
    runGitChecked(['branch', '-D', ctx.currentBranch], 'Failed to delete old feature branch');

    const remoteExists = spawnSync('git', ['ls-remote', '--exit-code', '--heads', 'origin', base]).status === 0;
    if (remoteExists) {
        process.stdout.write(ctx.prNumber ? `Updating PR #${ctx.prNumber} (force-with-lease)...\n` : 'Updating remote branch (force-with-lease)...\n');
        runGitChecked(['push', '-u', '--force-with-lease', 'origin', `${ctx.squashBranch}:${base}`], 'Failed to push to origin');
    } else {
        process.stdout.write('No remote branch — local only.\n');
    }
    runGitChecked(['checkout', ctx.squashBranch], 'Failed to checkout squash branch');
    runGitChecked(['branch', '-m', next], 'Failed to rename squash branch');

    // Branch now contains origin/main — stamp a clean main-sync status so the feature-branch-guard
    // unblocks edits immediately (no wait for the async refresher).
    stampCleanMainSyncStatus(execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim());

    process.stdout.write(`\n✅ Now on ${next} (remote/PR: ${base}), updated from main. Backup: ${ctx.backupBranch}\n`);
    process.stdout.write(`   Delete backup when safe: git branch -D ${ctx.backupBranch}\n\n`);
}

/**
 * Complete a 3-point squash merge. `conflictedFiles` non-null means a conflict was resolved by the AI
 * and must be validated + committed before finalizing; null means a clean merge that merge-START
 * already committed (finalize only). Either way the merge ends fully finalized on the feature branch.
 */
export async function mergeEnd(
    repoRoot: string, mergeDir: string, ctx: MergeContext, conflictedFiles: string[] | null,
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

    finalizeBranch(ctx);
    clearMergeMarker(mergeDir);
    await cleanTmp();
}
