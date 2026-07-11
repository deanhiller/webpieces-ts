import { MutationVerb, BranchMutationEvent, logBranchMutation } from '@webpieces/rules-config';
import { provideSingleton } from '@webpieces/core-context';
import { injectable } from 'inversify';
import { AiBranchName } from './git-readAiBranchName';
import { MergeState } from './merge-state';
import { MergeStart, MergeContext } from './merge-start';
import { MergeEnd } from './merge-end';

export type UpdateOutcome = 'finalized' | 'conflict' | 'unvalidatedResume';

// The shared "sync this feature branch from main" engine — a thin composition of the two lifecycle
// primitives (merge-START brings main in, merge-END finalizes). INTERNAL, not a bin: `wp-start-update`
// (standalone) and `wp-start-upsert-pr` (PR flow) both call it. It NEVER creates a PR and NEVER
// process.exits; it RETURNS an outcome so each caller prints the handoff that fits its context.
@provideSingleton()
@injectable()
export class RunUpdate {
    constructor(
        private readonly aiBranchName: AiBranchName,
        private readonly mergeState: MergeState,
        private readonly mergeStart: MergeStart,
        private readonly mergeEnd: MergeEnd,
    ) {}

    // `finishCommand` is the command the AI is told to run after resolving conflicts (standalone passes
    // `wp-finish-update`, PR flow passes `wp-finish-upsert-pr`). `verb` is the invoking bin, threaded so
    // every branch mutation is recorded in `.webpieces/hooks/branch-mutations.log`.
    async runUpdateFromMain(repoRoot: string, verb: MutationVerb, finishCommand: string): Promise<UpdateOutcome> {
        logBranchMutation(repoRoot, new BranchMutationEvent(verb, 'START'));
        const outcome = await this.runUpdate(repoRoot, verb, finishCommand);
        const end = new BranchMutationEvent(verb, 'END');
        end.outcome = outcome;
        logBranchMutation(repoRoot, end);
        return outcome;
    }

    private async runUpdate(repoRoot: string, verb: MutationVerb, finishCommand: string): Promise<UpdateOutcome> {
        const home = this.mergeState.mergeDirFor(repoRoot, this.aiBranchName.getFeatureName());

        // Resume path: an in-progress merge is the `merge-<n>/` run dir that holds a marker.
        const activeDir = this.mergeState.findActiveMergeRunDir(home);
        if (activeDir) {
            const existing = this.mergeState.readMergeMarker(activeDir);
            if (existing === null || !existing.validated) return 'unvalidatedResume';
            // Already validated → just finalize the branch swap (reads THIS run dir's marker).
            await this.mergeEnd.mergeEnd(
                repoRoot, verb, activeDir,
                new MergeContext(existing.currentBranch, existing.squashBranch, existing.backupBranch, existing.prNumber),
                null,
            );
            return 'finalized';
        }

        // Fresh update: mergeStart picks the slot number, creates its own `merge-<n>/` run dir, and
        // returns that path for merge-END to finalize against.
        const result = await this.mergeStart.mergeStart(repoRoot, verb, home, finishCommand);
        if (result.status === 'conflict' || result.context === null) {
            return 'conflict';
        }
        await this.mergeEnd.mergeEnd(repoRoot, verb, result.runDir, result.context, null);
        return 'finalized';
    }
}
