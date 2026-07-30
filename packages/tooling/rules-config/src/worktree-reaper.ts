import { spawnSync } from 'child_process';
import * as path from 'path';
import { injectable, bindingScopeValues } from 'inversify';

import {
    ArchiveResult,
    BranchArchiver,
    BRANCH_RETENTION_ARCHIVE_TAG,
    BRANCH_RETENTION_KEEP,
} from './branch-archiver';
import { BranchMutationEvent, BranchMutationLog, MutationVerb } from './branch-mutation-log';
import { CLASSIFICATION_PRUNABLE, DeletableWorktree } from './merged-branches';
import { Worktree, WorktreeService } from './worktrees';

/**
 * The EXECUTOR for the dead-WORKTREE verdicts that merged-branches.ts has been computing all along.
 *
 * WHY this exists: `DeletableWorktree` was designed for reaping — it carries `path` (what
 * `git worktree remove` takes) AND `branch` (what `git branch -D` takes afterwards) precisely because
 * a reap is always those two steps in that order. The reaping was then never wired up. The verdicts
 * had exactly one consumer, branch-creation-guard, which used them only to BLOCK: at the worktree cap
 * it printed the reap commands and refused to create the next worktree. Nothing ever ran them.
 *
 * That composes into a deadlock, not merely a missing feature. A merged worktree HOLDS its branch, so
 * the branch lands in `keep` with "checked out in worktree '<path>' — remove that worktree before
 * deleting the branch". Nothing removes the worktree. Both accumulate forever, and the guard's only
 * remaining advice is to loosen its own cap — which is the failure the cap exists to prevent. Observed
 * twice in one day: a `wp-cleanup` run that spared three worktree-held branches with that exact line,
 * and another that spared seven.
 *
 * THE ORDER IS FIXED AND LOAD-BEARING: archive the branch as a tag → `git worktree remove <path>` →
 * `git branch -D <branch>`.
 *  - Archive FIRST, and if it fails nothing is deleted. Same rule BranchArchiver already enforces for
 *    branches: a branch we could not tag is a branch whose only copy would be the reflog.
 *  - Remove the worktree BEFORE the branch, because git flatly refuses to delete a branch that is
 *    still checked out somewhere.
 *
 * AND NEVER `--force`. Git refuses to remove a worktree with uncommitted changes or untracked files,
 * and that refusal is the entire safety property here: a worktree removal deletes real FILES, not just
 * a ref, and an untracked file is by definition something no archive tag captured. A failed removal is
 * reported and moved past, exactly as a failed branch delete already is.
 */

// Data-only (per CLAUDE.md, classes for data). One worktree and what happened to it.
export class ReapedWorktree {
    path: string;
    // The branch the worktree held, '' when it was detached.
    branch: string;
    // The branch's tip BEFORE anything was destroyed. '' when it could not be resolved (or detached).
    sha: string;
    reason: string;
    pr: number;
    ok: boolean;
    // git's own stderr when ok=false. Kept verbatim — a refused removal is a thing a human must read.
    error: string;
    // The `archive/<date>/<branch>` tag written before the removal, or '' (policy 'delete', or detached).
    archiveTag: string = '';
    /**
     * Did the BRANCH delete also succeed? A worktree removal that succeeds while the branch delete
     * fails is a real, reportable half-state — the directory is gone, the branch is still there — and
     * collapsing it into `ok` would hide it. `ok` means the DIRECTORY is gone; this means the pair is.
     */
    branchDeleted: boolean = false;

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(treePath: string, branch: string, sha: string, reason: string, pr: number, ok: boolean, error: string) {
        this.path = treePath;
        this.branch = branch;
        this.sha = sha;
        this.reason = reason;
        this.pr = pr;
        this.ok = ok;
        this.error = error;
    }
}

/**
 * The outcome of one worktree reap. `spared` carries the worktrees we refused to touch, each with its
 * reason, for the same reason ReapResult does: a cleanup silent about what it did NOT remove reads as
 * "there was nothing else", when those are exactly the ones only a human can rule on.
 */
export class WorktreeReapResult {
    reaped: ReapedWorktree[];
    failed: ReapedWorktree[];
    spared: DeletableWorktree[];

    constructor(reaped: ReapedWorktree[], failed: ReapedWorktree[], spared: DeletableWorktree[]) {
        this.reaped = reaped;
        this.failed = failed;
        this.spared = spared;
    }
}

// The two never-removable sets, kept apart so each refusal can name its own reason (data-only class
// per CLAUDE.md — `primary` is the clone that owns .git, `current` is the tree wp-cleanup runs in).
class ProtectedPaths {
    primary: Set<string>;
    current: Set<string>;

    constructor(primary: Set<string>, current: Set<string>) {
        this.primary = primary;
        this.current = current;
    }
}

// Result of a captured git invocation. `err` carries stderr so a refused removal can be reported.
interface CmdCapture {
    ok: boolean;
    out: string;
    err: string;
}

@injectable(bindingScopeValues.Singleton)
export class WorktreeReaper {
    // Defaulted like BranchReaper's collaborators, so the non-DI call sites can just
    // `new WorktreeReaper()` while inversify still injects the singletons from a container.
    constructor(
        private readonly worktrees: WorktreeService = new WorktreeService(),
        private readonly mutationLog: BranchMutationLog = new BranchMutationLog(),
        private readonly archiver: BranchArchiver = new BranchArchiver(),
    ) {}

    /**
     * Reap every worktree in `targets`, skipping any the safety rails refuse.
     *
     * `cwd` is passed in rather than read from `process.cwd()` here so the "never remove the tree I am
     * standing in" rule is testable and so a caller running from a subdirectory still gets the right
     * answer — the containing WORKTREE is what matters, not the exact directory.
     *
     * `targets` is caller-chosen on purpose. wp-cleanup passes the provably-dead ones unattended, and
     * passes human-approved probably-dead ones on a second call. The safety rails below apply to both:
     * no answer at a prompt can authorise removing your own cwd or the primary clone.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    reapWorktrees(
        repoRoot: string,
        cwd: string,
        verb: MutationVerb,
        targets: DeletableWorktree[],
        retention: string = BRANCH_RETENTION_ARCHIVE_TAG,
    ): WorktreeReapResult {
        // 'keep' means "delete nothing, ever" — the reap degrades to a pure report, exactly as it does
        // for branches, so a repo that opted out of destructive cleanup still SEES what would have gone.
        if (retention === BRANCH_RETENTION_KEEP) return new WorktreeReapResult([], [], targets);

        const protectedPaths = this.protectedPaths(repoRoot, cwd);
        const reaped: ReapedWorktree[] = [];
        const failed: ReapedWorktree[] = [];
        const spared: DeletableWorktree[] = [];

        for (const target of targets) {
            const refusal = this.refuseReason(target, protectedPaths);
            if (refusal !== '') {
                spared.push(new DeletableWorktree(
                    target.path, target.branch, refusal, target.pr, false, target.classification));
                continue;
            }
            const outcome = this.removeOne(repoRoot, verb, target, retention);
            if (outcome.ok) reaped.push(outcome);
            else failed.push(outcome);
        }

        return new WorktreeReapResult(reaped, failed, spared);
    }

    /**
     * The two directories that must never be removed, resolved to absolute paths so a relative
     * `../foo` in a verdict can still be compared against them.
     *
     *  - THE PRIMARY CLONE. It owns `.git`; `git worktree remove` cannot take it, and a caller who
     *    somehow got it into a target list has a bug we must not execute.
     *  - THE TREE WE ARE STANDING IN. Removing your own cwd mid-command deletes the files underneath
     *    the running process — including, when the tooling is invoked by an agent, the checkout the
     *    agent's next tool call will try to read. merged-branches.ts already declines to mark it
     *    deletable; this is the second, independent line, because the caller supplies the list.
     */
    private protectedPaths(repoRoot: string, cwd: string): ProtectedPaths {
        const primary = new Set<string>();
        for (const tree of this.worktrees.listWorktrees(repoRoot)) {
            if (tree.isMain) primary.add(path.resolve(tree.path));
        }

        const here = new Set<string>();
        const current = this.currentTree(repoRoot, cwd);
        if (current !== null) here.add(path.resolve(current.path));
        // Fail SAFE when git could not name the current worktree: protect the raw paths anyway. An
        // over-protected path costs one worktree that survives to the next cleanup; an under-protected
        // one costs the directory the command is running in.
        here.add(path.resolve(repoRoot));
        here.add(path.resolve(cwd));
        return new ProtectedPaths(primary, here);
    }

    // The worktree record CONTAINING cwd — not merely the one whose path equals it, so `wp-cleanup`
    // run from `packages/whatever` inside a worktree still protects that worktree.
    private currentTree(repoRoot: string, cwd: string): Worktree | null {
        const here = path.resolve(cwd);
        let best: Worktree | null = null;
        for (const tree of this.worktrees.listWorktrees(repoRoot)) {
            const root = path.resolve(tree.path);
            if (here !== root && !here.startsWith(root + path.sep)) continue;
            // Longest match wins: worktrees can nest, and the innermost one is the one we are in.
            if (best === null || root.length > path.resolve(best.path).length) best = tree;
        }
        return best;
    }

    // '' when the target may be reaped; otherwise the human-readable reason it was spared instead. The
    // two rails report SEPARATELY: "you are standing in it" and "that is the primary clone" are
    // different mistakes, and a message covering both tells the reader neither.
    private refuseReason(target: DeletableWorktree, protectedPaths: ProtectedPaths): string {
        if (target.path === '') return 'no path recorded for this worktree — nothing safe to remove';
        const resolved = path.resolve(target.path);
        if (protectedPaths.primary.has(resolved)) {
            return 'refused — that is the primary clone, which owns .git and is not removable';
        }
        if (protectedPaths.current.has(resolved)) {
            return 'refused — this command is running in that worktree; removing your own cwd is a self-destruct';
        }
        return '';
    }

    /**
     * One worktree: ARCHIVE the branch, REMOVE the directory, then DELETE the branch — and stop at the
     * first step that fails.
     *
     * The prunable case is genuinely different and is why the classification token rides along on the
     * verdict: the directory is ALREADY gone, so `git worktree remove` fails on it and the reap is
     * `git worktree prune`. There is also nothing to archive from a directory that no longer exists —
     * the branch itself is still archived, since it may well still hold the only copy of some work.
     */
    private removeOne(
        repoRoot: string,
        verb: MutationVerb,
        target: DeletableWorktree,
        retention: string,
    ): ReapedWorktree {
        // Tip first: after the branch is gone there is nothing left to resolve, and the audit line's
        // whole job is to record what was destroyed while it still exists.
        const sha = target.branch !== '' ? this.revParse(repoRoot, target.branch) : '';

        const archive = this.archiveBranch(repoRoot, target, retention, sha);
        if (!archive.ok) return this.archiveFailed(repoRoot, verb, target, sha, archive);

        const removed = target.classification === CLASSIFICATION_PRUNABLE
            ? this.capture(repoRoot, ['worktree', 'prune'])
            : this.capture(repoRoot, ['worktree', 'remove', target.path]);
        if (!removed.ok) return this.removalFailed(repoRoot, verb, target, sha, archive, removed.err);

        // Only NOW may the branch go: git refuses while a worktree still holds it.
        const branchDeleted = target.branch === ''
            || this.capture(repoRoot, ['branch', '-D', target.branch]).ok;

        const result = new ReapedWorktree(
            target.path, target.branch, sha, target.reason, target.pr, true, '');
        result.archiveTag = archive.tag;
        result.branchDeleted = branchDeleted;

        this.log(repoRoot, verb, target, sha, archive.tag, branchDeleted
            ? `removed worktree and deleted branch (${target.reason})`
            : `removed worktree; branch '${target.branch}' survived (git refused the delete)`);
        return result;
    }

    // Archiving is skipped for a detached worktree (no branch to tag) and under retention 'delete'.
    // Both report ok=true with an empty tag: there is nothing to archive, which is not a failure.
    private archiveBranch(
        repoRoot: string, target: DeletableWorktree, retention: string, sha: string,
    ): ArchiveResult {
        if (target.branch === '' || retention !== BRANCH_RETENTION_ARCHIVE_TAG) {
            return new ArchiveResult('', sha, true, '');
        }
        return this.archiver.archive(repoRoot, target.branch);
    }

    // Archive refused ⇒ NOTHING is removed. The directory survives to the next cleanup, which is the
    // fail-safe direction: the alternative is deleting files whose branch has no permanent ref.
    // eslint-disable-next-line @typescript-eslint/max-params
    private archiveFailed(
        repoRoot: string, verb: MutationVerb, target: DeletableWorktree, sha: string, archive: ArchiveResult,
    ): ReapedWorktree {
        const error = `not removed — could not archive its branch first: ${archive.error}`;
        this.log(repoRoot, verb, target, sha, '', `SKIPPED (${error})`);
        return new ReapedWorktree(target.path, target.branch, sha, target.reason, target.pr, false, error);
    }

    /**
     * git refused to remove the directory — nearly always because it holds uncommitted changes or
     * untracked files. Reported with git's own words and moved past. We do NOT retry with `--force`:
     * an untracked file is work no archive tag captured, and `--force` is how a cleanup command turns
     * into a data-loss command. The branch is left alone too, since it is still checked out here.
     */
    // eslint-disable-next-line @typescript-eslint/max-params
    private removalFailed(
        repoRoot: string, verb: MutationVerb, target: DeletableWorktree, sha: string,
        archive: ArchiveResult, err: string,
    ): ReapedWorktree {
        const error = `git refused to remove it: ${err} (not forced — untracked or modified files are `
            + 'work nothing has archived; remove them or the worktree by hand)';
        this.log(repoRoot, verb, target, sha, archive.tag, `FAILED (${err})`);
        const result = new ReapedWorktree(
            target.path, target.branch, sha, target.reason, target.pr, false, error);
        result.archiveTag = archive.tag;
        return result;
    }

    // eslint-disable-next-line @typescript-eslint/max-params
    private log(
        repoRoot: string, verb: MutationVerb, target: DeletableWorktree,
        sha: string, archiveTag: string, outcome: string,
    ): void {
        const event = new BranchMutationEvent(verb, 'REAP_WORKTREE');
        event.fromBranch = target.branch;
        event.sha = sha;
        event.archiveTag = archiveTag;
        event.worktreePath = target.path;
        event.outcome = outcome;
        this.mutationLog.logBranchMutation(repoRoot, event);
    }

    /** The literal command that puts BOTH the directory and the branch back. */
    restoreCommand(target: ReapedWorktree): string {
        const ref = target.archiveTag !== '' ? target.archiveTag : target.sha;
        if (ref === '') return `git worktree add ${target.path} <ref>`;
        if (target.branch === '') return `git worktree add ${target.path} ${ref}`;
        return `git worktree add -b ${target.branch} ${target.path} ${ref}`;
    }

    private revParse(repoRoot: string, ref: string): string {
        const result = this.capture(repoRoot, ['rev-parse', ref]);
        return result.ok ? result.out : '';
    }

    // Run a git command capturing trimmed stdout/stderr; ok=false on spawn failure or non-zero exit.
    private capture(repoRoot: string, args: string[]): CmdCapture {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        const err = typeof result.stderr === 'string' ? result.stderr.trim() : '';
        if (result.status !== 0 || typeof result.stdout !== 'string') {
            return { ok: false, out: '', err: err !== '' ? err : 'git command failed' };
        }
        return { ok: true, out: result.stdout.trim(), err };
    }
}
