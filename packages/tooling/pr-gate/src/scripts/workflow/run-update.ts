import * as fs from 'fs';
import { MutationVerb, BranchMutationEvent, logBranchMutation } from '@webpieces/rules-config';
import { getFeatureName } from './git-readAiBranchName';
import { mergeDirFor, readMergeMarker } from './merge-state';
import { mergeStart, MergeContext } from './merge-start';
import { mergeEnd } from './merge-end';

// The shared "sync this feature branch from main" engine — a thin composition of the two lifecycle
// primitives (merge-START brings main in, merge-END finalizes). It is an INTERNAL function, not a
// bin: `wp-update-start` (standalone) and `wp-start-upsert-pr` (PR flow) both call it. It NEVER
// creates a PR and — unlike the old wp-git-update bin — it does NOT process.exit; it RETURNS an
// outcome so each caller can print the handoff that fits its context.
//
// `finishCommand` is the command the AI is told to run after resolving conflicts — the standalone
// caller passes `wp-update-end`, the PR flow passes `wp-finish-upsert-pr`.
//
// `verb` is the invoking bin, threaded through purely so every branch mutation (backup, checkout,
// pull, squash, rename) is recorded in `.webpieces/hooks/branch-mutations.log` under the command the
// user actually ran — the audit trail that used to exist only in `git reflog`.

export type UpdateOutcome = 'finalized' | 'conflict' | 'unvalidatedResume';

export async function runUpdateFromMain(repoRoot: string, verb: MutationVerb, finishCommand: string): Promise<UpdateOutcome> {
    logBranchMutation(repoRoot, new BranchMutationEvent(verb, 'START'));
    const outcome = await runUpdate(repoRoot, verb, finishCommand);
    const end = new BranchMutationEvent(verb, 'END');
    end.outcome = outcome;
    logBranchMutation(repoRoot, end);
    return outcome;
}

async function runUpdate(repoRoot: string, verb: MutationVerb, finishCommand: string): Promise<UpdateOutcome> {
    const mergeDir = mergeDirFor(repoRoot, getFeatureName());
    fs.mkdirSync(mergeDir, { recursive: true });

    // Resume path: a marker means a merge is already in progress.
    const existing = readMergeMarker(mergeDir);
    if (existing) {
        if (!existing.validated) return 'unvalidatedResume';
        // Already validated → just finalize the branch swap.
        await mergeEnd(
            repoRoot, verb, mergeDir,
            new MergeContext(existing.currentBranch, existing.squashBranch, existing.backupBranch, existing.prNumber),
            null,
        );
        return 'finalized';
    }

    // Fresh update: start, then finalize on clean / hand back on conflict.
    const result = await mergeStart(repoRoot, verb, mergeDir, finishCommand);
    if (result.status === 'conflict' || result.context === null) {
        return 'conflict';
    }
    await mergeEnd(repoRoot, verb, mergeDir, result.context, null);
    return 'finalized';
}
