/**
 * The "this branch is already merged, start fresh" text, shared by the TWO guards that detect the
 * state from the same cached signal (`MainSyncStatus.branchAlreadyMerged`):
 *
 *   - feature-branch-guard blocks Write/Edit  → {@link MergedBranchMessage.forEdits}
 *   - read-stale-guard     blocks Read        → {@link MergedBranchMessage.forReads}
 *
 * One source of truth on purpose: the recovery steps (`git checkout -b <new> origin/main`, never
 * `git checkout main` — it fatals inside a worktree) are instructions the AI follows LITERALLY, so
 * two drifting copies would mean two different behaviors for the same repo state. Only the
 * "what is still allowed" tail differs, because the two guards block different tools.
 */
export class MergedBranchMessage {
    // The diagnosis + cure. Identical for both guards — this is the part that must never drift.
    private common(branch: string, mergedPr: string): string[] {
        const pr = mergedPr !== '' ? ` (merged PR #${mergedPr})` : '';
        return [
            `It looks like you forgot to switch to main and delete this branch "${branch}" — its PR is already merged into main${pr}.`,
            'Your work is in main — do NOT keep editing this stale branch (you will reconflict with main).',
            'Start fresh — branch off origin/main (works on the primary repo AND inside a worktree; never',
            '`git checkout main`, which fatals in a worktree):',
            '  1. git fetch origin main',
            '  2. git checkout -b <new-feature-branch> origin/main',
        ];
    }

    forEdits(branch: string, mergedPr: string): string {
        return this.common(branch, mergedPr).concat([
            'Please add to memory: start a new branch off origin/main after a PR is merged.',
        ]).join('\n');
    }

    /**
     * The Read variant. Says WHY a read (not an edit) is blocked — reading this branch feeds the AI a
     * pre-merge snapshot of the codebase and every plan built on it is built on code main has already
     * moved past — and spells out the escape valves so the agent never believes it is stuck.
     */
    forReads(branch: string, mergedPr: string): string {
        return this.common(branch, mergedPr).concat([
            '',
            'Reads are blocked here because this branch is a PRE-MERGE snapshot: anything you read is',
            'stale relative to origin/main, and a plan built on it is built on code that has moved.',
            '',
            'Still allowed while this block is up:',
            '  - EVERY Bash command (the git commands above, installs, builds, all git/gh)',
            '  - All Write/Edit (feature-branch-guard governs those separately)',
            '  - Reading and editing webpieces.config.json (set read-stale-guard mode OFF to disable)',
            '',
            'Please add to memory: start a new branch off origin/main after a PR is merged.',
        ]).join('\n');
    }
}
