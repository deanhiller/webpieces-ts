#!/usr/bin/env node
import { execSync } from 'child_process';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { mergeDirFor, readMergeMarker } from './workflow/merge-state';
import { mergeEnd } from './workflow/merge-end';
import { MergeContext } from './workflow/merge-start';

// wp-merge-end — manual entry to the SECOND half of the 3-point squash-merge lifecycle (debug /
// recovery). Given an in-progress merge marker it validates + commits the AI's resolution (only when
// the marker is not yet validated) and ALWAYS finalizes the branch swap (squash→feature, push, stamp
// clean, clear marker). It does NOT run the build gate / dashboard / PR — that is wp-finish-upsert-pr.
// Use it to recover a stuck-but-resolved merge, or to finalize a clean `wp-merge-start`. Refuses to
// run when there is no merge in progress.

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const mergeDir = mergeDirFor(repoRoot, getFeatureName());

    const marker = readMergeMarker(mergeDir);
    if (!marker) {
        process.stderr.write('❌ No merge in progress (no marker) — nothing to finalize.\n');
        process.stderr.write('Start one with:  pnpm wp-git-update  (or pnpm wp-merge-start).\n');
        process.exit(1);
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

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
