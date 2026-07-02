#!/usr/bin/env node
import { execSync } from 'child_process';
import * as fs from 'fs';
import { writeTemplate } from '@webpieces/rules-config';
import { getFeatureName } from './workflow/git-readAiBranchName';
import { mergeDirFor, readMergeMarker, MergeMarker } from './workflow/merge-state';
import { mergeStart, MergeContext } from './workflow/merge-start';
import { mergeEnd } from './workflow/merge-end';

// wp-git-update: the "sync this feature branch from main" entry point (also the redirect target of the
// redirect-how-to-merge-main guard, and the first step wp-start-upsert-pr shells out to). It is a thin
// composition of the two lifecycle primitives: merge-START brings main in, merge-END finalizes. It
// NEVER creates a PR. Three cases: a fresh update (start → finalize on clean, hand back on conflict),
// resuming an already-validated merge (finalize), or resuming an unvalidated one (tell the AI to run
// wp-finish-upsert-pr, which validates + finalizes via merge-END).

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

async function handleResume(repoRoot: string, mergeDir: string, marker: MergeMarker): Promise<void> {
    if (!marker.validated) {
        process.stdout.write('\n' + SEP + '⏸️  Merge in progress — not yet validated\n' + SEP + '\n');
        process.stdout.write('Resolve the remaining conflicts in the working tree, then run:\n');
        process.stdout.write('  pnpm wp-finish-upsert-pr\n\n');
        process.exit(1);
    }
    process.stdout.write('Resuming: merge validated — finalizing.\n');
    await mergeEnd(
        repoRoot, mergeDir,
        new MergeContext(marker.currentBranch, marker.squashBranch, marker.backupBranch, marker.prNumber),
        null,
    );
}

export async function main(): Promise<void> {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    const featureName = getFeatureName();
    const mergeDir = mergeDirFor(repoRoot, featureName);
    fs.mkdirSync(mergeDir, { recursive: true });
    // Refresh the AI-facing workflow doc so it's present + current for any failure message to cite.
    writeTemplate(repoRoot, 'webpieces.git-workflow.md');

    const existing = readMergeMarker(mergeDir);
    if (existing) {
        await handleResume(repoRoot, mergeDir, existing);
        return;
    }

    const result = await mergeStart(repoRoot, mergeDir);
    if (result.status === 'conflict' || result.context === null) {
        // Conflicts: marker + context files written, AI hands resolution off to wp-finish-upsert-pr.
        process.exit(2);
    }
    await mergeEnd(repoRoot, mergeDir, result.context, null);
}

if (require.main === module) {
    main().catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(message + '\n');
        process.exit(1);
    });
}
