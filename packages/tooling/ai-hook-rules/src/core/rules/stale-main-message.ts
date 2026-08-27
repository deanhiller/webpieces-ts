import { atRoot } from '@webpieces/rules-config';

/**
 * The "you are on a stale main" text. ONE consumer today:
 *
 *   - read-stale-guard        blocks the Read tool     → {@link StaleMainMessage.forReads}
 *
 * It had a second consumer, `forBash`, for the days when stale-main-bash-guard blocked CONTENT reads
 * on a stale main. That guard judges the SAME state again today (rows 6/7 — `main`, known behind), but
 * its verdict shape is different: default-deny plus the row 4 skip list rather than a per-file call,
 * and its cure is the branch form alone because a Bash session cannot be cured by staying put. So it
 * carries its own message and this variant was deleted rather than left as a second spelling.
 *
 * One source of truth on purpose (same reason as MergedBranchMessage): the cure is an instruction the
 * AI follows literally, so two drifting copies mean two behaviours for one repo state.
 *
 * Cure 1 is `pnpm wp-checkout-clean-main`, the ONE command this repo names for "make local `main`
 * current" — and it is now spelled that way here because it was not, which is the defect this file's
 * last change fixed. Fleet-wide, this rule handed agents FOUR different refresh-main cures across 238
 * prescriptions and the sanctioned one appeared in 6 of them; CLAUDE.md meanwhile names
 * `pnpm wp-checkout-clean-main` and explicitly forbids hand-rolling the `git checkout main && git pull`
 * pair, because that is the same command minus the orphan-directory sweep. Agents caught between the
 * two authorities improvised hybrids — four distinct spellings observed — each costing a blocked round
 * trip. A cure is an instruction the AI follows LITERALLY, so there is exactly one spelling of it.
 *
 * It still fast-forwards rather than merging (the command pulls `--ff-only`), which is what keeps this
 * message clear of the merge redirect-how-to-merge-main exists to prevent, and it is still CLEAN-TREE
 * ONLY. Cure 2 (`git checkout -b`) is what makes the message correct on a dirty tree, so both are
 * printed and each is labelled.
 *
 * NOTE the intents stay SEPARATE. Cure 2 is not a spelling of cure 1: refreshing `main` in place and
 * branching off fresh are different moves with different tree-state requirements, and collapsing them
 * would hand a dirty tree a cure it cannot run.
 */
export class StaleMainMessage {
    /**
     * `treeRoot` is the tree the guard JUDGED (which is NOT the shell's cwd when the command carried
     * a leading `cd`). Pass it and each cure is rendered as `cd <treeRoot> && <cure>`, naming the
     * directory outright.
     *
     * WHY that matters here specifically: in the field this guard told an agent working in a worktree
     * to `git pull` — which, run from wherever the next tool call happened to start, meant pulling the
     * PRIMARY CLONE, a tree that agent had been explicitly instructed not to touch. A remedy must
     * never mutate a tree other than the one the command targeted, and naming it is how you ensure it.
     */
    constructor(private readonly treeRoot: string = '') {}

    /**
     * The diagnosis + BOTH cures.
     *
     * Two cures rather than one, and that is what let the dirty valve be deleted. The guard used to
     * fail open on a dirty tree because the only cure it printed was the in-place pull, which is
     * not a clean fast-forward when there are local modifications — so the block was suppressed to
     * avoid prescribing something that could not run.
     *
     * The row always had a second cure (`git checkout -b <new> origin/main`), and that one works
     * DIRTY: it carries uncommitted changes onto the new branch and lands you on current code, which
     * is the whole objective. Printing it unconditionally means the message is correct in both tree
     * states, so nothing has to detect dirtiness — no extra `git status --porcelain` on the block
     * path, and no state in which the printed cure is unrunnable.
     */
    private common(behindCount: string): string[] {
        const refresh = 'pnpm wp-checkout-clean-main';
        const branch = 'git checkout -b <new-branch> origin/main';
        return [
            `You are on main and main is ${behindCount} commit(s) behind origin/main.`,
            ...(this.treeRoot !== '' ? [`Evaluated against: ${this.treeRoot}  (branch main)`] : []),
            'Anything you read here is STALE, and every plan built from it is built on code that no',
            'longer exists upstream.',
            '',
            'Run ONE of these, then retry:',
            `  1. ${this.treeRoot !== '' ? atRoot(this.treeRoot, refresh) : refresh}`,
            '     Updates main in place — checkout, pull, reap dead branches/worktrees, sweep orphan',
            '     directories. CLEAN TREE ONLY: with tracked modifications the pull is not a',
            '     fast-forward and it will refuse.',
            `  2. ${this.treeRoot !== '' ? atRoot(this.treeRoot, branch) : branch}`,
            '     Works with UNCOMMITTED CHANGES — they come with you onto the new branch, and you',
            '     land on current code. Prefer this one if you have edits in flight, or if 1 refused.',
            '',
            'If 1 fatals with "Cannot fast-forward to multiple branches", .git/FETCH_HEAD holds a',
            'duplicate entry — clear it with `git fetch --prune origin main`, then run 1 again.',
            'If 2 refuses because origin/main changed the same files you edited, run `git stash`',
            '(never blocked), then 2 again, then `git stash pop`.',
        ];
    }

    forReads(behindCount: string): string {
        return this.common(behindCount).concat([
            '',
            'Still allowed while this block is up:',
            '  - Bash that does not read repo files: builds, tests, installs, the pull itself, and all',
            '    git/gh METADATA (status|log|diff|show|branch)',
            '  - All Write/Edit (feature-branch-guard governs those separately)',
            '  - Reading and editing webpieces.config.json (set read-stale-guard mode OFF to disable)',
        ]).join('\n');
    }

}
