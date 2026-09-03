import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import { toError } from './to-error';

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
const HEAD_KEY = 'HEAD ';
const LOCKED_KEY = 'locked ';
const REFS_HEADS = 'refs/heads/';

/**
 * Whether a worktree is being worked in, and the reason in the words an operator gets shown.
 *
 * Data-only (per CLAUDE.md, classes for data). A bare boolean was the first cut and it collapsed
 * "there are uncommitted files here" into "git would not answer me" — two different things to tell
 * somebody who is deciding whether a directory is safe to remove.
 */
export class WorktreeWorkInFlight {
    held: boolean;
    reason: string;

    constructor(held: boolean, reason: string) {
        this.held = held;
        this.reason = reason;
    }
}

// Data-only (per CLAUDE.md, classes for data).
export class Worktree {
    path: string;
    // Short branch name (refs/heads/ stripped). Empty when the worktree is detached or bare.
    branch: string;
    /**
     * The commit this worktree's HEAD is at, verbatim from the `HEAD <sha>` line every porcelain record
     * already carries. '' only for a bare worktree, which has no HEAD at all.
     *
     * Load-bearing, and the reason it stopped being dropped by the parser: a BRANCH NAME does not
     * identify a tree. A second clone, or a stale worktree, can hold the same name at a different
     * commit — which is the wrong-objects-under-the-right-name failure `wp-land-pr` already refused to
     * make from the tree it happened to be standing in. Pairing the name with this sha turns that veto
     * into a SELECTION: the tree to archive from and reap is the one whose HEAD is the exact commit
     * GitHub squashed, whichever directory the operator is standing in. See LandedTreeResolver.
     */
    head: string;
    // The primary clone — the one that owns .git. Never counted against the cap, never removable.
    isMain: boolean;
    // git already knows this worktree's directory is gone; `git worktree prune` will clear it.
    prunable: boolean;
    // Somebody ran `git worktree lock`. WHO is a question only `lockReason` can answer.
    locked: boolean;
    /**
     * The `--reason` text verbatim, '' when the lock carried none.
     *
     * Load-bearing, not decoration: the Claude Code agent harness locks every worktree it opens for a
     * subagent and writes a machine-readable reason naming the agent and its pid. Without this field
     * `locked` collapsed a live agent, a dead agent and a human into one verdict, and wp-cleanup
     * reported all three as "locked by a human". See agent-worktree-lock.ts.
     */
    lockReason: string;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(
        path: string,
        branch: string,
        // REQUIRED, with no default, for the same reason lockReason is: a defaulted '' would read as
        // "this tree is not at any commit", and every sha comparison built on it would silently decline.
        head: string,
        isMain: boolean,
        prunable: boolean,
        locked: boolean,
        // REQUIRED, with no default. A 5-arg construction would silently mean "no reason recorded",
        // which routes straight back to the bug this exists to fix — every agent lock unreadable and
        // its worktree spared forever. A missing argument must be a compile error, not a quiet ''.
        lockReason: string,
    ) {
        this.path = path;
        this.branch = branch;
        this.head = head;
        this.isMain = isMain;
        this.prunable = prunable;
        this.locked = locked;
        this.lockReason = lockReason;
    }
}

// Result of a captured git invocation: ok=false on spawn failure or non-zero exit.
interface CmdCapture {
    ok: boolean;
    out: string;
}

@injectable(bindingScopeValues.Singleton)
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
     * Am I standing in a LINKED worktree (as opposed to the primary clone)?
     *
     * This is the question every recovery message needs, because the two trees take different
     * commands: `git checkout main` fatals inside a linked worktree ("main is already checked out
     * at <primary>"), and a dead linked worktree is reaped with `git worktree remove`, not
     * `git branch -d`. A guard that cannot tell them apart must print BOTH forms and let the AI
     * guess — which is exactly how an AI ends up running the fatal one.
     *
     * The test is a single `statSync`, no process spawn: git gives a linked worktree a `.git` FILE
     * (a `gitdir:` pointer) where the primary clone has a `.git` DIRECTORY. This runs on the read
     * path, where reads vastly outnumber every other tool call, so the cost matters.
     *
     * It is a CHEAP FAST PATH over the authoritative answer, not a second authority. The authority is
     * `DotWebpieces.gitDirs` — `gitDir !== commonDir`, git's own canonical test, which also handles the
     * layouts a `.git` stat cannot see (`--separate-git-dir`, submodules). This is NOT calling it,
     * deliberately: that costs a `rev-parse` spawn per read. `worktree-identity.spec.ts` asserts the two
     * agree for the primary clone, an in-repo `.claude/worktrees/**` worktree and a sibling worktree
     * outside the repo — so if git ever changes the `.git` layout this fails there, not in the field.
     * Anything that needs to be RIGHT rather than cheap (tree identity, state paths) asks `gitDirs`.
     *
     * Returns FALSE on anything uncertain (no `.git` at all, unreadable, a submodule's `.git` file
     * in a non-worktree checkout). False is the fail-open direction here: callers then print both
     * forms rather than confidently printing the wrong one.
     */
    isLinkedWorktree(root: string): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            return !fs.statSync(path.join(root, '.git')).isDirectory();
        } catch (err: unknown) {
            const error = toError(err);
            void error;
            return false;
        }
    }

    /**
     * Is somebody working in this worktree — and if so, WHY do we say that?
     *
     * THE ONE CHECK THAT MAKES A ZERO-COMMIT WORKTREE UNREAPABLE. A ref with no commits of its own
     * loses nothing when it is deleted — that is a property of the REF. A DIRECTORY is different:
     * every worktree looks exactly like that husk from `git worktree add -b` until its first commit,
     * which is precisely the window an agent is working in. `git status --porcelain` is what tells
     * those two apart, and it is one cheap local spawn per candidate.
     *
     * It returns the REASON rather than a bare boolean because the two ways of being held are not the
     * same sentence to a human: "it has uncommitted files" is a fact about the tree, and "git could
     * not tell me" is a fact about our evidence. Both spare the worktree — unknown must fail SAFE,
     * since the fail-safe direction for deleting a directory is to leave it — but reporting the
     * second as the first tells an operator to go look for edits that are not there.
     */
    workInFlight(worktreePath: string): WorktreeWorkInFlight {
        const result = spawnSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' });
        if (result.status !== 0 || typeof result.stdout !== 'string') {
            return new WorktreeWorkInFlight(true,
                '`git status` could not report on it, so it is not provably empty');
        }
        if (result.stdout.trim() !== '') {
            return new WorktreeWorkInFlight(true, 'has uncommitted or untracked files');
        }
        return new WorktreeWorkInFlight(false, '');
    }

    /**
     * The worktree record for the tree rooted at `root`, or null when it is not one of git's
     * worktrees (or git could not answer). Callers use it to name the exact directory a
     * `git worktree remove` has to take — a reap instruction with the wrong path is worse than none.
     */
    currentWorktree(root: string): Worktree | null {
        const resolved = path.resolve(root);
        for (const tree of this.listWorktrees(root)) {
            if (path.resolve(tree.path) === resolved) return tree;
        }
        return null;
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
        let head = '';
        let prunable = false;
        let locked = false;
        let lockReason = '';

        const flush = (): void => {
            if (path === '') return;
            trees.push(new Worktree(path, branch, head, trees.length === 0, prunable, locked, lockReason));
            path = '';
            branch = '';
            head = '';
            prunable = false;
            locked = false;
            lockReason = '';
        };

        for (const raw of out.split('\n')) {
            const line = raw.trim();
            if (line === '') {
                flush();
            } else if (line.startsWith(WORKTREE_KEY)) {
                // A new record begins — flush the previous one in case the blank line was missing.
                flush();
                path = line.slice(WORKTREE_KEY.length).trim();
            } else if (line.startsWith(HEAD_KEY)) {
                // Already on the wire — git emits it for every non-bare record, detached ones included.
                head = line.slice(HEAD_KEY.length).trim();
            } else if (line.startsWith(BRANCH_KEY)) {
                const ref = line.slice(BRANCH_KEY.length).trim();
                branch = ref.startsWith(REFS_HEADS) ? ref.slice(REFS_HEADS.length) : ref;
            } else if (line === 'prunable' || line.startsWith('prunable ')) {
                prunable = true;
            } else if (line === LOCKED_KEY.trim() || line.startsWith(LOCKED_KEY)) {
                locked = true;
                // `locked` alone is a lock with no --reason; `locked <text>` carries the reason verbatim.
                lockReason = line.slice(LOCKED_KEY.length).trim();
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
