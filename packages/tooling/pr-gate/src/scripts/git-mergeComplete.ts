#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { runGitChecked } from './workflow/git-exec';
import { runConfiguredBuildGate } from './workflow/build-affected';
import { MERGE_EXPLANATION_FILE } from '@webpieces/rules-config';
import {
    mergeDirFor,
    perFileContextDir,
    readMergeMarker,
    writeMergeMarker,
    scanConflictMarkers,
    scanMergeExplanations,
} from './workflow/merge-state';

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
        process.stderr.write('\nResolve them, then re-run: pnpm wp-git-merge-complete\n');
        process.exit(1);
    }

    // 2. Ensure git itself has no remaining unmerged entries.
    const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    if (unmerged !== '') {
        process.stderr.write('❌ Git still reports unmerged files:\n' + unmerged + '\n');
        process.stderr.write('\nResolve and `git add` them, then re-run: pnpm wp-git-merge-complete\n');
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
            'then re-run: pnpm wp-git-merge-complete\n',
        );
        process.exit(1);
    }
    process.stdout.write('✅ Merge explanations present for all resolved files.\n');
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const featureName = getFeatureName();
    const mergeDir = mergeDirFor(repoRoot, featureName);

    const marker = readMergeMarker(mergeDir);
    if (!marker) {
        process.stderr.write('❌ No merge in progress (no marker found). Nothing to complete.\n');
        process.exit(1);
        return;
    }
    if (marker.validated) {
        process.stdout.write('✅ Merge already validated. Run pnpm wp-git-update (or wp-upsert-pr) to finalize.\n');
        return;
    }

    process.stdout.write('\n' + SEP + '🔎 Validating Merge Resolution\n' + SEP + '\n');

    validateResolution(repoRoot, mergeDir, marker.conflictedFiles);
    runGitChecked(['add', '-A'], 'Failed to stage resolved files');

    // Build gate (authoritative). Same configured command wp-upsert-pr uses — fast on a big monorepo.
    const buildCode = runConfiguredBuildGate(repoRoot);
    if (buildCode !== 0) {
        process.stderr.write('\n❌ Build failed. Fix the build, then re-run: pnpm wp-git-merge-complete\n');
        process.exit(buildCode);
        return;
    }
    process.stdout.write('\n✅ Build passed.\n');

    // Commit the resolved squash merge.
    const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
    if (!nothingStaged) {
        runGitChecked(
            ['commit', '-m', `Squash merge of ${marker.currentBranch} (conflicts resolved)`],
            'Failed to commit resolved merge',
        );
    }

    // Flip the marker to validated + drop the proof file → unblocks the guard.
    marker.validated = true;
    writeMergeMarker(mergeDir, marker);
    fs.writeFileSync(path.join(mergeDir, 'conflicts-resolved'), '');

    process.stdout.write('\n' + SEP + '✅ Merge validated and committed\n' + SEP + '\n');
    process.stdout.write('Finalize & push by running:  pnpm wp-upsert-pr  (or pnpm wp-git-update)\n\n');
}

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
