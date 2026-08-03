import {
    MutationVerb,
    DeletableWorktree,
    MergedBranchesService,
    ReapedWorktree,
    WorktreeReapResult,
    WorktreeReaper,
    CLASSIFICATION_LOCKED,
    CLASSIFICATION_CURRENT,
    CLASSIFICATION_DETACHED,
    CLASSIFICATION_PRUNABLE,
    PROMPTABLE_CLASSIFICATIONS,
} from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

/**
 * The WORKTREE half of `wp-cleanup` — the verdicts, the reap and the human-facing text.
 *
 * Split out of CleanupCommand rather than bolted onto it because the two halves answer different
 * questions: a branch is a ref, a worktree is a DIRECTORY OF FILES, and the second one needs its own
 * report (paths, not just names), its own restore command (`git worktree add`, not `git checkout -b`)
 * and its own spared vocabulary (locked, detached, "you are standing in it"). Keeping them in one class
 * meant every string had to hedge about which kind of thing it was talking about.
 *
 * WHY worktrees are reaped BEFORE branches in wp-cleanup: a worktree HOLDS its branch, so that branch
 * is spared as `in-use` with "remove that worktree before deleting the branch". Reaping the worktree
 * first is what makes the branch reapable — the reap takes the branch with it, and the branch pass that
 * follows recomputes its verdicts against the post-removal truth. Run the other way round, every
 * worktree-held branch survives forever, which is exactly the deadlock this change exists to break.
 */
@injectable(bindingScopeValues.Singleton)
export class WorktreeCleanupSection {
    constructor(
        private readonly mergedBranches: MergedBranchesService,
        private readonly reaper: WorktreeReaper,
    ) {}

    /**
     * FRESH verdicts — never the cache on disk. Same rule the branch half follows: the cached file is
     * deliberately allowed to go stale, which is fine for BLOCKING a `git worktree add` and never fine
     * for removing a directory, since the tree may have gained uncommitted work since it was written.
     */
    verdicts(repoRoot: string): DeletableWorktree[] {
        return this.mergedBranches.computeMergedBranches(repoRoot).worktrees;
    }

    provablyDead(verdicts: DeletableWorktree[]): DeletableWorktree[] {
        return verdicts.filter((tree: DeletableWorktree): boolean => tree.deletable);
    }

    /**
     * The spared worktrees a human can meaningfully rule on, grouped most-safe first — the same
     * classification order the branch prompt uses, because it is literally the same verdict on the
     * branch the worktree holds.
     *
     * Deliberately excluded: LOCKED (a human already said do not touch), CURRENT (removing your own cwd
     * is not a thing to offer), DETACHED (no branch, so nothing to archive and nothing to judge) and
     * PRUNABLE (already provably dead — it is in the auto-reap list, not this one).
     */
    promptable(verdicts: DeletableWorktree[]): DeletableWorktree[] {
        const out: DeletableWorktree[] = [];
        for (const classification of PROMPTABLE_CLASSIFICATIONS) {
            for (const tree of verdicts) {
                if (!tree.deletable && tree.classification === classification) out.push(tree);
            }
        }
        return out;
    }

    reap(
        repoRoot: string,
        verb: MutationVerb,
        targets: DeletableWorktree[],
        retention: string,
    ): WorktreeReapResult {
        return this.reaper.reapWorktrees(repoRoot, process.cwd(), verb, targets, retention);
    }

    report(result: WorktreeReapResult): string {
        if (result.reaped.length === 0 && result.failed.length === 0) return '';

        let out = '\n' + SEP + `🌲 Removed ${String(result.reaped.length)} dead worktree(s)\n` + SEP + '\n';
        for (const entry of result.reaped) out += this.reapedLine(entry);

        if (result.failed.length > 0) {
            out += `\n⚠️  ${String(result.failed.length)} worktree(s) could not be removed:\n`;
            for (const entry of result.failed) out += `  ✗ ${entry.path} — ${entry.error}\n`;
        }
        // Printed on success too: removing a worktree deletes real files, and a human who cannot see
        // how to undo that has to take it on trust — which is precisely what nobody should have to do.
        out += '\nEvery removal is logged in .webpieces/logs/branch-mutations.log (phase REAP_WORKTREE)\n'
            + 'with the `recover=` command that brings back both the directory and its branch.\n';
        return out;
    }

    private reapedLine(entry: ReapedWorktree): string {
        const branch = entry.branch !== '' ? ` [${entry.branch}]` : ' [detached]';
        // The restore command is printed inline for the same reason the branch half prints the archive
        // tag: it is the one thing that makes this reversible without going and digging in a log.
        const restore = `\n      restore: ${this.reaper.restoreCommand(entry)}`;
        // A directory that went while its branch survived is a real half-state and must not read as done.
        const partial = entry.branch !== '' && !entry.branchDeleted
            ? `\n      ⚠️  the branch '${entry.branch}' was NOT deleted — git refused it`
            : '';
        return `  ✓ ${entry.path}${branch} — ${entry.reason}${restore}${partial}\n`;
    }

    /** The spared worktrees, with WHY — including the ones nobody will ever be asked about. */
    sparedBlock(verdicts: DeletableWorktree[], removed: DeletableWorktree[]): string {
        const gone = new Set(removed.map((tree: DeletableWorktree): string => tree.path));
        const spared = verdicts.filter(
            (tree: DeletableWorktree): boolean => !tree.deletable && !gone.has(tree.path)
                && this.isMechanical(tree.classification));
        if (spared.length === 0) return '';
        let out = '\nWorktrees deliberately left alone:\n';
        for (const tree of spared) out += `  · ${tree.path} — ${tree.reason}\n`;
        return out;
    }

    private isMechanical(classification: string): boolean {
        return classification === CLASSIFICATION_LOCKED
            || classification === CLASSIFICATION_CURRENT
            || classification === CLASSIFICATION_DETACHED
            || classification === CLASSIFICATION_PRUNABLE;
    }

    // The table a human answers: path, branch, and the same reason the branch prompt would show, since
    // the verdict IS the branch's verdict.
    promptBlock(promptable: DeletableWorktree[]): string {
        let out = '\n' + SEP
            + `🤔 ${String(promptable.length)} worktree(s) are probably dead — your call\n` + SEP + '\n'
            + 'Removing one deletes its DIRECTORY and its branch. The branch is archived as a tag first,\n'
            + 'so both come back with one `git worktree add -b …` — but uncommitted or untracked files in\n'
            + 'that directory are NOT archived, and git will refuse the removal if any exist.\n\n';
        for (let i = 0; i < promptable.length; i += 1) {
            const tree = promptable[i];
            out += `  [${String(i + 1)}] ${tree.path}\n        [${tree.branch}] — ${tree.reason}\n`;
        }
        return out;
    }
}
