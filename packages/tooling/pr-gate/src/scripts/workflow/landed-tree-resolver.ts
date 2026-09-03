import { spawnSync } from 'child_process';
import { Worktree, WorktreeService } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';

/**
 * WHICH LOCAL TREE HOLDS THE COMMIT GITHUB JUST SQUASHED — asked as a fact, answered from anywhere.
 *
 * `wp-land-pr` does two things with different scopes: the MERGE belongs to the PR and is reachable from
 * any directory, while the BOOKKEEPING (archive the pre-squash tip, promote merge-info, reap the landed
 * worktree) belongs to the tree that really holds those objects. Until now the second half was resolved
 * from `process.cwd()` — and `pnpm` hoists a bin's cwd to the workspace root, so a command run inside
 * `<primary>/.claude/worktrees/agent-<id>` executed in the PRIMARY CLONE. Every agent worktree is nested
 * like that, so the answer was wrong in exactly the case the mechanism was built for.
 *
 * The fix is to stop asking "where am I" and start asking "where is it". Both halves of that question are
 * facts nobody has to record:
 *
 *   `gh pr view <n> --json headRefName,headRefOid`  →  the branch, and the exact commit being squashed
 *   `git worktree list --porcelain`                 →  every (path, branch, HEAD sha) in this repo
 *
 * The worktree list lives in the COMMON dir, so it reads identically from the primary clone, from any
 * linked worktree, and from a coordinator that never saw the agent that built the branch. That is what
 * makes `wp-land-pr --pr <n>` able to finish a dead agent's work.
 *
 * ─── WHY THE PAIR, AND NEVER THE NAME ALONE ───────────────────────────────────────────────────────
 * A branch NAME does not identify a tree. A second clone, or a worktree somebody has since committed to,
 * holds the same name at a different commit, and archiving `archive/<date>/<branch>` from there tags the
 * wrong objects under the right name. So the selection key is `(headRefName, headRefOid)` together, and a
 * name-only match is never enough to remove or archive anything — in this process or in the child that
 * re-verifies it (see ReapWorktreeCommand).
 *
 * ─── WHY NOT A `.webpieces/**` RECEIPT ────────────────────────────────────────────────────────────
 * The obvious alternative is for `wp-finish-upsert-pr` to write `{ pr, branch, worktreePath, headRefOid }`
 * to a sidecar and for landing to read it back. `decisions/0005-the-pr-description-is-the-merge-body.md`
 * already deleted that pattern once: a recorded claim can only ever be missing, stale, or on the wrong
 * computer — and a worktree PATH is more volatile than the commit body that argument was made about,
 * since the directory is moved, reaped, or recreated under a new agent id between finish and land.
 * `(headRefOid, git worktree list)` is a pair of facts, needs no stored state, and works from a fresh
 * clone. Nothing here reads state.
 */

/** A linked worktree holds the branch AT the squashed commit: archive here, and reap THAT directory. */
export const LANDED_TREE_WORKTREE = 'worktree';
/** No worktree holds it, but the branch ref in this repo IS the squashed commit: archive, nothing to reap. */
export const LANDED_TREE_BRANCH_ONLY = 'branch-only';
/** The name is here, the commit is not. Merge stands; bookkeeping is declined out loud. */
export const LANDED_TREE_WRONG_TIP = 'wrong-tip';
/** The branch is not in this repo at all — landed from a tree that does not hold it. */
export const LANDED_TREE_ABSENT = 'absent';

/**
 * Data-only (per CLAUDE.md, classes for data). Where the landed commit lives locally, and therefore
 * whether the bookkeeping half may run at all.
 *
 * `bookkeepingAllowed` is PRECOMPUTED rather than re-derived by the caller, for the same reason
 * `EffectiveTree.redirected` and `WorktreeReapHandoff.canReap` are: a deletion rule spelled out twice is
 * a deletion rule that eventually disagrees with itself.
 */
export class LandedTree {
    readonly kind: string;
    /** The linked worktree to reap — non-null ONLY for {@link LANDED_TREE_WORKTREE}. */
    readonly worktree: Worktree | null;
    /** The sha found locally under that branch name, '' when the branch is absent. Printed on a mismatch. */
    readonly localSha: string;
    readonly bookkeepingAllowed: boolean;

    constructor(kind: string, worktree: Worktree | null, localSha: string) {
        this.kind = kind;
        this.worktree = worktree;
        this.localSha = localSha;
        this.bookkeepingAllowed = kind === LANDED_TREE_WORKTREE || kind === LANDED_TREE_BRANCH_ONLY;
    }
}

@injectable(bindingScopeValues.Singleton)
export class LandedTreeResolver {
    constructor(private readonly worktrees: WorktreeService) {}

    /**
     * The four-row table this whole design exists to implement, in order of what it can prove.
     *
     * `headRefOid === ''` means `gh` did not tell us which commit it is squashing. That cannot be turned
     * into a mismatch — a fact we do not have is not evidence of disagreement — so the local tip is taken
     * as the landed one, which is exactly what the old `ref.headRefOid !== ''` guard did.
     */
    resolve(repoRoot: string, branch: string, headRefOid: string): LandedTree {
        // Only LINKED worktrees are reapable; the primary clone is the thing reaped FROM, never a target.
        const holder = this.worktrees.linkedWorktrees(repoRoot)
            .find((tree: Worktree): boolean => tree.branch === branch) ?? null;
        const local = holder !== null ? holder.head : this.revParse(repoRoot, branch);

        if (local === '') return new LandedTree(LANDED_TREE_ABSENT, null, '');
        if (headRefOid !== '' && local !== headRefOid) {
            return new LandedTree(LANDED_TREE_WRONG_TIP, null, local);
        }
        return holder !== null
            ? new LandedTree(LANDED_TREE_WORKTREE, holder, local)
            : new LandedTree(LANDED_TREE_BRANCH_ONLY, null, local);
    }

    // Best-effort sha of a ref — '' when it cannot resolve, which reads as "the branch is not here".
    private revParse(repoRoot: string, ref: string): string {
        const result = spawnSync('git', ['rev-parse', ref], { cwd: repoRoot, encoding: 'utf8' });
        return result.status === 0 ? (result.stdout ?? '').trim() : '';
    }
}
