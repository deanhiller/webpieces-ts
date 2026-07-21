import { TreeRecovery, TreeKind } from './tree-recovery';

/**
 * The "this branch is already merged, start fresh" text, shared by the TWO guards that detect the
 * state from the same cached signal (`MainSyncStatus.branchAlreadyMerged`):
 *
 *   - feature-branch-guard blocks Write/Edit  → {@link MergedBranchMessage.forEdits}
 *   - read-stale-guard     blocks Read        → {@link MergedBranchMessage.forReads}
 *
 * One source of truth on purpose: the recovery steps are instructions the AI follows LITERALLY, so
 * two drifting copies would mean two different behaviors for the same repo state. Only the
 * "what is still allowed" tail differs, because the two guards block different tools.
 *
 * The steps themselves come from {@link TreeRecovery}, which renders them in the flavour of the tree
 * we are actually standing in — a merged LINKED WORKTREE is told to open a new worktree and remove
 * this dead one, a merged branch in the primary clone is told to `git checkout -b … origin/main`.
 * Neither is ever told to `git checkout main`, which fatals in a worktree.
 */
export class MergedBranchMessage {
    private readonly recovery = new TreeRecovery();

    // The diagnosis + cure. Identical for both guards — this is the part that must never drift.
    private common(branch: string, mergedPr: string, kind: TreeKind, worktreePath: string): string[] {
        const pr = mergedPr !== '' ? ` (merged PR #${mergedPr})` : '';
        const where = kind === 'worktree' ? 'worktree' : 'branch';
        const lines = [
            `It looks like you forgot to clean up this ${where} "${branch}" — its PR is already merged into main${pr}.`,
            'Your work is in main — do NOT keep working here (you will reconflict with main).',
            '',
            ...this.recovery.freshStartSteps(kind, '<new-feature-branch>'),
        ];

        // Only when we KNOW we are in a dead worktree: the branch cure alone leaves the worktree
        // sitting there, spending the worktree budget (branch-creation-guard.maxWorktrees) forever.
        if (kind === 'worktree') {
            lines.push('', 'Then reap this dead worktree:', ...this.recovery.cleanupSteps(kind, branch, worktreePath).slice(-1));
        }
        return lines;
    }

    forEdits(branch: string, mergedPr: string, kind: TreeKind = 'unknown', worktreePath: string = '<worktree-dir>'): string {
        return this.common(branch, mergedPr, kind, worktreePath).concat([
            '',
            'Please add to memory: start a new branch/worktree off origin/main after a PR is merged.',
        ]).join('\n');
    }

    /**
     * The Read variant. Says WHY a read (not an edit) is blocked — reading this branch feeds the AI a
     * pre-merge snapshot of the codebase and every plan built on it is built on code main has already
     * moved past — and spells out the escape valves so the agent never believes it is stuck.
     */
    forReads(branch: string, mergedPr: string, kind: TreeKind = 'unknown', worktreePath: string = '<worktree-dir>'): string {
        return this.common(branch, mergedPr, kind, worktreePath).concat([
            '',
            'Reads are blocked here because this tree is a PRE-MERGE snapshot: anything you read is',
            'stale relative to origin/main, and a plan built on it is built on code that has moved.',
            '',
            'Still allowed while this block is up:',
            '  - EVERY Bash command (the git commands above, installs, builds, all git/gh)',
            '  - All Write/Edit (feature-branch-guard governs those separately)',
            '  - Reading and editing webpieces.config.json (set read-stale-guard mode OFF to disable)',
            '',
            'Please add to memory: start a new branch/worktree off origin/main after a PR is merged.',
        ]).join('\n');
    }
}
