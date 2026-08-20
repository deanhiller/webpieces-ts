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
 *
 * ONE VOICE on `git checkout main`: only the WORKTREE flavour says never to run it (there it fatals —
 * main is checked out in the primary clone). In the primary clone it is a perfectly good move and the
 * allowance list below says so explicitly. The two used to disagree inside a single message — the
 * header forbade it while the allowance list permitted "git checkout <other-branch>", and `main` is an
 * other-branch — and an agent that resolved the contradiction in favour of the prohibition concluded
 * its only exit was creating a branch, which the branch cap then refused.
 */
export class MergedBranchMessage {
    private readonly recovery: TreeRecovery;

    /**
     * `treeRoot` is the tree the guard judged — pass it and every prescribed command comes out as
     * `cd <treeRoot> && …`. That form is the only one that is correct across tool calls: the harness
     * RESETS a cwd that left the workspace, so an agent in a linked worktree is back in the primary
     * clone by the time it runs the cure, and a bare `git checkout -b` would branch the WRONG tree.
     */
    constructor(private readonly treeRoot: string = '') {
        this.recovery = new TreeRecovery(treeRoot);
    }

    /**
     * The ONE allowance list, shared by every guard that blocks while this state is up.
     *
     * Each guard used to print its own view of the world: this one's narrow bash allowlist, and
     * read-stale-guard's "EVERY Bash command". Both statements were true of their own guard and false
     * of the session — on a merged branch BOTH fire, so the agent was told simultaneously that all
     * Bash runs and that most Bash is blocked. One list, printed by both.
     */
    private allowances(kind: TreeKind): string[] {
        const switching = kind === 'worktree'
            ? '  - switching away: git checkout/switch <other-branch> (NOT `git checkout main` — it fatals ' +
              'in a worktree; use `git fetch origin main`), git worktree add/remove/prune'
            : '  - switching away: git checkout/switch <other-branch> — `main` included, so ' +
              '`pnpm wp-checkout-clean-main` (checkout main, pull it, reap dead branches and ' +
              'worktrees, sweep orphan directories) is allowed and is the shortest exit; also ' +
              'git worktree add/remove/prune';
        return [
            'Still allowed while this block is up (these get you OFF this branch — run one, then retry):',
            '  - the fresh-start / cleanup git commands above',
            '  - read-only orientation: git status|log|diff|show|branch',
            '  - gh GENERALLY (pr view, pr close, pr comment, api, run watch — it talks to GitHub, not to this tree), and curl/wget; NOT gh repo clone / pr checkout / run download, curl -o, or any `> file`, which write here',
            switching,
            '  - pnpm wp-checkout-clean-main, pnpm wp-cleanup and the gated wp-start-*/wp-finish-* commands, pnpm install / upgrades',
            '  - output shaping on any of the above: `… 2>&1 | tail -40`, `… | head -5`, `…; echo done`',
            '  - reading and editing webpieces.config.json (the mode-OFF escape hatch for these guards)',
            '',
            'NOT allowed on this branch, by the sibling guards that fire on the same state: ordinary Bash',
            '(merged-branch-bash-guard), Read (read-stale-guard) and Write/Edit (feature-branch-guard).',
            'One list — all three guards print exactly this one.',
        ];
    }

    // The diagnosis + cure. Identical for both guards — this is the part that must never drift.
    private common(branch: string, mergedPr: string, kind: TreeKind, worktreePath: string): string[] {
        const pr = mergedPr !== '' ? ` (merged PR #${mergedPr})` : '';
        const where = kind === 'worktree' ? 'worktree' : 'branch';
        const lines = [
            `It looks like you forgot to clean up this ${where} "${branch}" — its PR is already merged into main${pr}.`,
            // Name the tree that was judged. With several agents running in parallel worktrees, a guard
            // that reasons from the shell cwd can block a command while citing an UNRELATED agent's
            // branch — observed live. Printing the directory makes a wrong judgement visible instead of
            // baffling, and lets the reader see immediately that it is not the tree they meant.
            ...(this.treeRoot !== '' ? [`Evaluated against: ${this.treeRoot}  (branch ${branch})`] : []),
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
            ...this.allowances(kind),
            '',
            'Please add to memory: start a new branch/worktree off origin/main after a PR is merged.',
        ]).join('\n');
    }

    /**
     * The Bash variant. merged-branch-bash-guard DEFAULT-DENIES Bash on a merged branch, so the message
     * has to spell out the narrow allowlist — otherwise an agent reads "blocked" and believes it is
     * wedged. The cure commands it lists are exactly the ones the allowlist lets through (including the
     * `| tail`/`; echo` shaping an agent reflexively appends), so following this message can never hit
     * the guard again.
     */
    forBash(branch: string, mergedPr: string, kind: TreeKind = 'unknown', worktreePath: string = '<worktree-dir>'): string {
        return this.common(branch, mergedPr, kind, worktreePath).concat([
            '',
            'Bash is blocked here because working on a merged branch (booting servers, running builds,',
            'reading files with cat/ls) operates on a PRE-MERGE snapshot that origin/main has moved past.',
            '',
            ...this.allowances(kind),
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
            ...this.allowances(kind),
            '',
            'Please add to memory: start a new branch/worktree off origin/main after a PR is merged.',
        ]).join('\n');
    }
}
