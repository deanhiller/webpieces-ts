#!/usr/bin/env node
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadPrGateConfig } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { runGitChecked } from './workflow/git-exec';
import { runBuildAffected } from './workflow/build-affected';
import {
    mergeDirFor,
    readMergeMarker,
    writeMergeMarker,
    scanConflictMarkers,
} from './workflow/merge-state';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

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

    // 1. Scoped conflict-marker scan (only the conflicted files — O(conflicts), not O(repo)).
    const scan = scanConflictMarkers(repoRoot, marker.conflictedFiles);
    if (!scan.clean) {
        process.stderr.write('❌ Unresolved conflict markers (<<<<<<< / ======= / >>>>>>>) remain in:\n');
        for (const file of scan.filesWithMarkers) process.stderr.write(`  - ${file}\n`);
        process.stderr.write('\nResolve them, then re-run: pnpm wp-git-merge-complete\n');
        process.exit(1);
        return;
    }

    // 2. Ensure git itself has no remaining unmerged entries.
    const unmerged = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' }).trim();
    if (unmerged !== '') {
        process.stderr.write('❌ Git still reports unmerged files:\n' + unmerged + '\n');
        process.stderr.write('\nResolve and `git add` them, then re-run: pnpm wp-git-merge-complete\n');
        process.exit(1);
        return;
    }

    process.stdout.write('✅ No conflict markers in resolved files.\n');
    runGitChecked(['add', '-A'], 'Failed to stage resolved files');

    // 3. Build gate (authoritative). nx affected — fast on a big monorepo.
    const buildCode = runBuildAffected(repoRoot, loadPrGateConfig(repoRoot).buildCommand);
    if (buildCode !== 0) {
        process.stderr.write('\n❌ Build failed. Fix the build, then re-run: pnpm wp-git-merge-complete\n');
        process.exit(buildCode);
        return;
    }
    process.stdout.write('\n✅ Build passed.\n');

    // 4. Commit the resolved squash merge.
    const nothingStaged = spawnSync('git', ['diff-index', '--quiet', '--cached', 'HEAD', '--']).status === 0;
    if (!nothingStaged) {
        runGitChecked(
            ['commit', '-m', `Squash merge of ${marker.currentBranch} (conflicts resolved)`],
            'Failed to commit resolved merge',
        );
    }

    // 5. Flip the marker to validated + drop the proof file → unblocks the guard.
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
