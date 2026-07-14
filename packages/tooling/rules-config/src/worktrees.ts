import { spawnSync } from 'child_process';
import { provideSingleton } from './di';
import { injectable } from 'inversify';

/**
 * Reading the git worktree list.
 *
 * WHY this exists separately from merged-branches: a worktree is a SECOND budget. Every worktree holds
 * a branch, so if worktree-held branches also counted against the local-branch cap, five worktrees
 * would consume the entire branch budget and no branch could ever be created again. The two are
 * therefore counted apart — held branches against the worktree cap, parked branches against the branch
 * cap — and this service is what tells the two apart.
 *
 * Unlike the merged-PR lookup, everything here is LOCAL and cheap (one `git worktree list`), so it is
 * safe to call on the guard's blocking path.
 */

// `git worktree list --porcelain` emits blank-line-separated records. The first record is always the
// main worktree. Keys are space-separated; `detached`, `bare` and `locked` may appear bare (no value).
const WORKTREE_KEY = 'worktree ';
const BRANCH_KEY = 'branch ';
const REFS_HEADS = 'refs/heads/';

// Data-only (per CLAUDE.md, classes for data).
export class Worktree {
    path: string;
    // Short branch name (refs/heads/ stripped). Empty when the worktree is detached or bare.
    branch: string;
    // The primary clone — the one that owns .git. Never counted against the cap, never removable.
    isMain: boolean;
    // git already knows this worktree's directory is gone; `git worktree prune` will clear it.
    prunable: boolean;
    // A human ran `git worktree lock`. Explicitly "do not touch".
    locked: boolean;

    constructor(path: string, branch: string, isMain: boolean, prunable: boolean, locked: boolean) {
        this.path = path;
        this.branch = branch;
        this.isMain = isMain;
        this.prunable = prunable;
        this.locked = locked;
    }
}

// Result of a captured git invocation: ok=false on spawn failure or non-zero exit.
interface CmdCapture {
    ok: boolean;
    out: string;
}

@provideSingleton()
@injectable()
export class WorktreeService {
    /**
     * Every worktree, main one first. Fails SOFT to [] — a repo with no worktree support, or a git
     * that errors, must read as "no worktrees" so the cap fails OPEN rather than blocking on data we
     * do not have.
     */
    listWorktrees(repoRoot: string): Worktree[] {
        const result = this.capture(repoRoot, ['worktree', 'list', '--porcelain']);
        if (!result.ok || result.out === '') return [];
        return this.parsePorcelain(result.out);
    }

    // The linked worktrees — everything except the primary clone. This is what the cap counts.
    linkedWorktrees(repoRoot: string): Worktree[] {
        return this.listWorktrees(repoRoot).filter((tree: Worktree): boolean => !tree.isMain);
    }

    /**
     * Branch names checked out in ANY worktree, including the primary clone's own HEAD.
     *
     * Two callers, one reason: git flatly refuses to delete a branch that is checked out somewhere.
     * A held branch must never be proposed for `git branch -D` (the delete would fail and take the
     * whole reap command down with it), and it must not be counted as a parked branch either.
     */
    heldBranches(repoRoot: string): Set<string> {
        const held = new Set<string>();
        for (const tree of this.listWorktrees(repoRoot)) {
            if (tree.branch !== '') held.add(tree.branch);
        }
        return held;
    }

    /**
     * Parse the porcelain records. A record starts at a `worktree <path>` line and runs to the blank
     * line; the FIRST record is the main worktree (git guarantees the ordering). A `prunable` worktree
     * still appears in the list, which is exactly why it can be reaped.
     */
    private parsePorcelain(out: string): Worktree[] {
        const trees: Worktree[] = [];
        let path = '';
        let branch = '';
        let prunable = false;
        let locked = false;

        const flush = (): void => {
            if (path === '') return;
            trees.push(new Worktree(path, branch, trees.length === 0, prunable, locked));
            path = '';
            branch = '';
            prunable = false;
            locked = false;
        };

        for (const raw of out.split('\n')) {
            const line = raw.trim();
            if (line === '') {
                flush();
            } else if (line.startsWith(WORKTREE_KEY)) {
                // A new record begins — flush the previous one in case the blank line was missing.
                flush();
                path = line.slice(WORKTREE_KEY.length).trim();
            } else if (line.startsWith(BRANCH_KEY)) {
                const ref = line.slice(BRANCH_KEY.length).trim();
                branch = ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
            } else if (line === 'prunable' || line.startsWith('prunable ')) {
                prunable = true;
            } else if (line === 'locked' || line.startsWith('locked ')) {
                locked = true;
            }
        }
        flush();

        return trees;
    }

    // Run a git command capturing trimmed stdout; ok=false on spawn failure or non-zero exit.
    private capture(repoRoot: string, args: string[]): CmdCapture {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status !== 0 || typeof result.stdout !== 'string') return { ok: false, out: '' };
        return { ok: true, out: result.stdout.trim() };
    }
}
