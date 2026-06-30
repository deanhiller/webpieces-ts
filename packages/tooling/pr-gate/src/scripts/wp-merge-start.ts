#!/usr/bin/env node
import { execSync } from 'child_process';
import * as fs from 'fs';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { mergeDirFor, readMergeMarker, writeMergeMarker, MergeMarker } from './workflow/merge-state';
import { mergeStart } from './workflow/merge-start';

// wp-merge-start — manual entry to the FIRST half of the 3-point squash-merge lifecycle (debug /
// recovery). Most callers want `pnpm wp-git-update`, which runs start AND finalize in one go. This
// runs ONLY merge-START: it brings origin/main in and, on conflict, writes the 3-point context +
// marker and hands back for resolution (exit 2). On a CLEAN merge it leaves the squash staged and
// records a validated marker so a SEPARATE `pnpm wp-merge-end` can finalize the branch swap. It
// refuses to run if a merge is already in progress (a marker is present).

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const mergeDir = mergeDirFor(repoRoot, getFeatureName());
    fs.mkdirSync(mergeDir, { recursive: true });

    if (readMergeMarker(mergeDir)) {
        process.stderr.write('❌ A merge is already in progress (marker present) — refusing to start another.\n');
        process.stderr.write('Resolve any conflicts, then run:  pnpm wp-finish-upsert-pr  (or pnpm wp-merge-end to only finalize).\n');
        process.exit(1);
    }

    const result = await mergeStart(repoRoot, mergeDir);
    if (result.status === 'conflict' || result.context === null) {
        // Conflicts: merge-START wrote the marker + context files and printed the handback.
        process.exit(2);
    }

    // Clean merge: persist a validated marker so a separate `wp-merge-end` process can finalize
    // (the in-memory context is otherwise lost between commands). hashes/conflictedFiles are unused
    // by finalize, so they are empty here.
    const ctx = result.context;
    writeMergeMarker(mergeDir, new MergeMarker(
        ctx.currentBranch, ctx.squashBranch, ctx.backupBranch, ctx.prNumber, [], '', '', '', true,
    ));
    process.stdout.write('\n✅ Clean squash staged on ' + ctx.squashBranch + '. Finalize with:  pnpm wp-merge-end\n');
}

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
