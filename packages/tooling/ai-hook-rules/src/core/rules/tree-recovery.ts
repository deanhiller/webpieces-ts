import { WorktreeService } from '@webpieces/rules-config';

/**
 * Renders the "get onto a healthy tree" commands, in the flavour of the tree the AI is standing in.
 *
 * WHY this exists: the SAME recovery advice takes different commands in a linked worktree than in
 * the primary clone, and getting it wrong is not a cosmetic problem — the AI runs these strings
 * literally:
 *
 *   - `git checkout main` FATALS in a linked worktree ("main is already checked out at <primary>"),
 *     so any message that recommends it burns a turn and then strands the agent.
 *   - a dead linked worktree is reaped with prune → remove → `git branch -D`, in that exact order,
 *     because git flatly refuses to delete a branch a worktree still holds. `git branch -d` alone
 *     just fails.
 *
 * Four guards used to hand-write these two forms independently (feature-branch-guard,
 * read-stale-guard, pr-merge-guard, redirect-how-to-merge-main), so they drifted. This is the one
 * place they come from now.
 *
 * The `TreeKind` contract, and why UNKNOWN prints BOTH: detection is a cheap local probe that can
 * fail (see WorktreeService.isLinkedWorktree). When we KNOW, we print exactly the one command that
 * works there — no menu for the AI to mis-pick from. When we do NOT know, we print both, clearly
 * labelled, because a labelled choice is recoverable and a confidently-wrong command is not.
 */
export type TreeKind = 'worktree' | 'branch' | 'unknown';

export class TreeRecovery {
    private readonly worktrees = new WorktreeService();

    /**
     * `treeRoot` is the tree the guard JUDGED. When it is given, every command below is rendered as
     * `cd <treeRoot> && <command>`.
     *
     * WHY: a Bash tool call does NOT persist `cd` between calls, so an agent working in a linked
     * worktree starts every call back in the primary clone. A bare `git fetch origin main` therefore
     * runs against the WRONG tree — and in the field a guard prescribed `git pull` in a primary clone
     * the agent had been explicitly forbidden to touch. Naming the directory in the command itself is
     * the only form that is correct no matter where the next tool call starts. A leading `cd <path> &&`
     * cannot change what a command does to a repo, so the guards accept it.
     *
     * Empty (the default) renders the bare commands, for callers with no root to name.
     */
    constructor(private readonly treeRoot: string = '') {}

    /** The kind of tree rooted at `root`, for callers that have a workspace root and no other info. */
    kindOf(root: string): TreeKind {
        return this.worktrees.isLinkedWorktree(root) ? 'worktree' : 'branch';
    }

    // Render one command in the form that survives a tool call: `cd <root> && <command>`.
    private at(command: string): string {
        return this.treeRoot === '' ? command : `cd ${this.treeRoot} && ${command}`;
    }

    /**
     * Start fresh off current main. Both forms base explicitly on `origin/main` — the only base that
     * works from ANY tree (branch-creation-guard allows it unconditionally for that reason).
     */
    freshStartSteps(kind: TreeKind, newBranchName: string = '<new-feature-branch>'): string[] {
        // The worktree DIRECTORY cannot carry the branch's slashes. When the branch name is itself a
        // placeholder the AI must fill in, keep the directory a readable placeholder too — sanitizing
        // `<new-feature-branch>` produced `../-new-feature-branch-`, which reads like a real path and
        // is exactly the kind of thing an agent pastes verbatim.
        const dir = newBranchName.includes('<')
            ? '<feature-dir>'
            : newBranchName.replace(/\//g, '-');
        const branchForm = [
            `  ${this.at('git fetch origin main')}`,
            `  ${this.at(`git checkout -b ${newBranchName} origin/main`)}`,
        ];
        const worktreeForm = [
            `  ${this.at('git fetch origin main')}`,
            `  ${this.at(`git worktree add ../${dir} -b ${newBranchName} origin/main`)}`,
        ];

        if (kind === 'worktree') {
            return [
                'You are in a linked worktree (`git checkout main` fatals here — main is checked out in',
                'the primary clone). Start the new work in its own worktree:',
                ...worktreeForm,
            ];
        }
        // The primary clone. NO "never `git checkout main`" here: that is a WORKTREE-only truth, and
        // printing it in the primary clone forbids the shortest exit off a merged branch
        // (`git checkout main && git pull origin main && pnpm wp-cleanup` — the exact command a human
        // had to hand an agent that had wedged itself following this very message). Branching off
        // origin/main is still what we RECOMMEND, because it works from any tree; it is no longer
        // dressed up as the only legal move.
        if (kind === 'branch') {
            return ['Start fresh — branch off origin/main (works from here and from any worktree):', ...branchForm];
        }
        return [
            'Start fresh off origin/main. Pick the form for the tree you are in:',
            '  - in the primary clone:',
            ...branchForm.map((line: string): string => `  ${line}`),
            '  - in a linked worktree (`git checkout main` fatals there):',
            ...worktreeForm.map((line: string): string => `  ${line}`),
        ];
    }

    /**
     * Reap the tree you just finished with. The worktree order is load-bearing: prune clears
     * worktrees whose directory is already gone (`git worktree remove` FAILS on those), and the
     * branch delete must come LAST because git refuses to delete a branch a worktree still holds.
     *
     * The BRANCH form ends in `pnpm wp-cleanup`, not `git branch -d <branch>`. An agent reads a bare
     * `-d`/`-D` as destructive and stops to ask permission, so the branch survives the turn and local
     * branches pile up — the exact failure this whole cleanup path exists to prevent. wp-cleanup is
     * one named command that deletes only provably-dead branches (and reaps every OTHER dead one at
     * the same time), so it is safe to allowlist and never needs a judgement call.
     *
     * The WORKTREE form still spells out git commands: wp-cleanup deliberately reaps parked branches
     * only — a worktree-held branch is spared — so it cannot do this job, and the prune → remove →
     * delete ordering is the part that has to be exactly right.
     */
    cleanupSteps(kind: TreeKind, branch: string, worktreePath: string = '<worktree-dir>'): string[] {
        const branchForm = `  ${this.at('git checkout main && git pull origin main && pnpm wp-cleanup')}`;
        const worktreeForm =
            `  git worktree prune && git worktree remove ${worktreePath} && git branch -D ${branch}`;

        if (kind === 'worktree') {
            return [
                'You are in a linked worktree — remove the worktree first, then the branch (git refuses',
                'to delete a branch a worktree still holds). Run this from the PRIMARY clone:',
                worktreeForm,
            ];
        }
        if (kind === 'branch') {
            return ['Clean up the merged branch:', branchForm];
        }
        return [
            'Clean up. Pick the form for the tree you are in:',
            '  - in the primary clone:',
            `  ${branchForm}`,
            '  - for a linked worktree (run from the primary clone; `git branch -d` alone fails while',
            '    a worktree still holds the branch):',
            `  ${worktreeForm}`,
        ];
    }

    /**
     * Bring main up to date. In a linked worktree there is nothing to check out — `main` lives in
     * the primary clone — so the update is a plain fetch of the remote-tracking ref, which is all
     * you need to then branch off `origin/main`.
     */
    updateMainSteps(kind: TreeKind): string[] {
        const branchForm = `  ${this.at('git checkout main && git pull origin main')}`;
        const worktreeForm = `  ${this.at('git fetch origin main')}        (then work off origin/main)`;

        if (kind === 'worktree') {
            return [
                'You are in a linked worktree — `git checkout main` fatals here (main is checked out in',
                'the primary clone). Update the remote-tracking ref instead:',
                worktreeForm,
            ];
        }
        if (kind === 'branch') {
            return ['Update main:', branchForm];
        }
        return [
            'Update main. Pick the form for the tree you are in:',
            '  - in the primary clone:',
            `  ${branchForm}`,
            '  - in a linked worktree (`git checkout main` fatals there):',
            `  ${worktreeForm}`,
        ];
    }
}
