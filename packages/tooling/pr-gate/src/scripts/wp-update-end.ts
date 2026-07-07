#!/usr/bin/env node
import { execSync } from 'child_process';
import { CliExitError, runMain } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { mergeDirFor, readMergeMarker } from './workflow/merge-state';
import { mergeEnd } from './workflow/merge-end';
import { MergeContext } from './workflow/merge-start';

// wp-update-end — finalize half of the 3-point squash-merge lifecycle. Run it AFTER `wp-update-start`
// handed back conflicts and you resolved them. Given an in-progress merge marker it validates +
// commits the AI's resolution (when the marker is not yet validated) and ALWAYS finalizes the branch
// swap (squash→feature, push, stamp clean, clear marker). It does NOT run the build gate / dashboard
// / PR — that is wp-finish-upsert-pr (the PR flow's finish). Refuses to run when there is no merge in
// progress (a clean `wp-update-start` finalizes on its own — there is nothing left for this to do).

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const mergeDir = mergeDirFor(repoRoot, getFeatureName());

    const marker = readMergeMarker(mergeDir);
    if (!marker) {
        throw new CliExitError(1,
            '❌ No merge in progress (no marker) — nothing to finalize.\n' +
            'Start one with:  pnpm wp-update-start  (a clean update finalizes itself).',
        );
    }

    // Not yet validated => a conflict resolution the AI owns, so validate + commit it first; already
    // validated => clean merge (or previously validated) => finalize only.
    const conflictedFiles = marker.validated ? null : marker.conflictedFiles;
    await mergeEnd(
        repoRoot, mergeDir,
        new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
        conflictedFiles,
    );
    process.stdout.write('\n✅ Merge finalized on ' + marker.currentBranch + '.\n');
}

if (require.main === module) runMain(main);
