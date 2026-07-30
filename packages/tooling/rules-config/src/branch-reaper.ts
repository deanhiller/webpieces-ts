import { spawnSync } from 'child_process';
import { injectable, bindingScopeValues } from 'inversify';

import {
    ArchiveResult,
    BranchArchiver,
    BRANCH_RETENTION_ARCHIVE_TAG,
    BRANCH_RETENTION_KEEP,
} from './branch-archiver';
import { BranchMutationEvent, BranchMutationLog, MutationVerb } from './branch-mutation-log';
import { DeletableBranch, MergedBranchesCache, MergedBranchesService } from './merged-branches';

/**
 * The EXECUTOR for the dead-branch verdicts that merged-branches.ts computes.
 *
 * WHY this exists: for a long time nothing in the tooling ever deleted a branch. The reap was only
 * ever a `git branch -D a b c` STRING embedded in a guard's fix hint, handed to an AI agent — which
 * reads a raw `-D` as destructive, asks "may I clean this up?", and stops. So the verdicts were
 * computed correctly on every hook call and then acted on by nobody, and local branches grew without
 * bound. The fix is not better wording; it is a thing that does the deleting.
 *
 * WHY deleting here is safe: every entry in `deletable` earned its place by one of exactly three
 * proofs — a MERGED PR (the work is in main), a squash-merge BACKUP of a merged branch, or ZERO
 * commits of its own (there is no work). merged-branches.ts also guarantees `main` is never in the
 * list and that a branch checked out in ANY worktree lands in `keep` instead, so we can never delete
 * the branch someone is standing on. On top of that, every delete is logged with the branch's
 * pre-delete SHA and a literal recover command, so no reap is unrecoverable.
 */

// Data-only (per CLAUDE.md, classes for data). One branch and what happened to it.
export class ReapedBranch {
    branch: string;
    // The commit the branch pointed at BEFORE deletion — captured first, precisely so a delete is
    // always undoable via `git branch <branch> <sha>`. Empty only if rev-parse itself failed.
    sha: string;
    reason: string;
    pr: number;
    ok: boolean;
    // git's own stderr when ok=false. Kept verbatim: a failed delete is a thing a human must read.
    error: string;
    /**
     * The `archive/<date>/<branch>` tag written immediately BEFORE the delete, or '' when the retention
     * policy is 'delete'. Non-empty means the branch is restorable by NAME rather than by remembering a
     * sha — `git checkout -b <branch> <tag>` restores the exact objects, and the tag survives `gc` and
     * reflog expiry. Field-with-default so every existing `new ReapedBranch(...)` call site still builds.
     */
    archiveTag: string = '';

    // eslint-disable-next-line @typescript-eslint/max-params
    constructor(branch: string, sha: string, reason: string, pr: number, ok: boolean, error: string) {
        this.branch = branch;
        this.sha = sha;
        this.reason = reason;
        this.pr = pr;
        this.ok = ok;
        this.error = error;
    }
}

/**
 * The outcome of one reap. `spared` is carried alongside deliberately: a cleanup that silently says
 * nothing about the branches it did NOT touch reads as "there was nothing else", when in fact those
 * are exactly the branches only a human can rule on.
 */
export class ReapResult {
    reaped: ReapedBranch[];
    failed: ReapedBranch[];
    spared: DeletableBranch[];

    constructor(reaped: ReapedBranch[], failed: ReapedBranch[], spared: DeletableBranch[]) {
        this.reaped = reaped;
        this.failed = failed;
        this.spared = spared;
    }
}

// Result of a captured git invocation. `err` carries stderr so a failed delete can be reported.
interface CmdCapture {
    ok: boolean;
    out: string;
    err: string;
}

@injectable(bindingScopeValues.Singleton)
export class BranchReaper {
    // Defaulted so the non-DI call sites (the detached refresher in sync-main.ts) can just
    // `new BranchReaper()`, while inversify still injects the singletons when resolved from a
    // container. Mirrors how MergedBranchesService defaults its WorktreeService.
    constructor(
        private readonly mergedBranches: MergedBranchesService = new MergedBranchesService(),
        private readonly mutationLog: BranchMutationLog = new BranchMutationLog(),
        private readonly archiver: BranchArchiver = new BranchArchiver(),
    ) {}

    /**
     * Delete every branch the verdicts call dead, one command at a time.
     *
     * `cache` is an ALREADY-FRESH set of verdicts (the refresher just computed them, so re-running
     * the `gh` lookup would be pure waste). Pass nothing — as `wp-cleanup` does — and we recompute
     * from scratch. That distinction is load-bearing: the cache file on disk is DELIBERATELY allowed
     * to go stale, which is fine for blocking a branch creation but is not fine for deleting, since a
     * branch may have gained commits since it was written. Deleting never reads the stale file.
     */
    reap(
        repoRoot: string,
        verb: MutationVerb,
        cache: MergedBranchesCache | null = null,
        retention: string = BRANCH_RETENTION_ARCHIVE_TAG,
    ): ReapResult {
        const verdicts = cache ?? this.mergedBranches.computeMergedBranches(repoRoot);
        // 'keep' means "never delete anything" — the reap becomes a pure report. Everything still lands
        // in `spared` so the human sees exactly what WOULD have been reaped under the other policies.
        if (retention === BRANCH_RETENTION_KEEP) {
            return new ReapResult([], [], [...verdicts.deletable, ...verdicts.keep]);
        }
        return this.reapBranches(repoRoot, verb, verdicts.deletable, retention, verdicts);
    }

    /**
     * Delete a CALLER-SUPPLIED list of branches — the branches a human just said yes to at wp-cleanup's
     * classification prompt. Separate from `reap` because these are NOT provably dead: they earned their
     * deletion from an explicit human answer, not from a verdict, so nothing here may ever run unattended.
     * Archiving still happens first, which is precisely what makes that yes low-stakes.
     */
    reapApproved(
        repoRoot: string,
        verb: MutationVerb,
        approved: DeletableBranch[],
        retention: string = BRANCH_RETENTION_ARCHIVE_TAG,
    ): ReapResult {
        if (retention === BRANCH_RETENTION_KEEP) return new ReapResult([], [], approved);
        const reaped: ReapedBranch[] = [];
        const failed: ReapedBranch[] = [];
        for (const entry of approved) {
            const outcome = this.deleteOne(repoRoot, verb, entry, retention);
            if (outcome.ok) reaped.push(outcome);
            else failed.push(outcome);
        }
        return new ReapResult(reaped, failed, []);
    }

    private reapBranches(
        repoRoot: string,
        verb: MutationVerb,
        targets: DeletableBranch[],
        retention: string,
        verdicts: MergedBranchesCache,
    ): ReapResult {
        const reaped: ReapedBranch[] = [];
        const failed: ReapedBranch[] = [];
        for (const entry of targets) {
            const outcome = this.deleteOne(repoRoot, verb, entry, retention);
            if (outcome.ok) reaped.push(outcome);
            else failed.push(outcome);
        }

        this.rewriteCache(repoRoot, verdicts, failed);
        return new ReapResult(reaped, failed, verdicts.keep);
    }

    /**
     * One branch: ARCHIVE the tip as a tag, then one `git branch -D`. Never the multi-name form the old
     * fix hint used: git aborts the whole command on the first branch it refuses, which would strand
     * every branch after it in the list. One invocation each means one failure costs exactly one branch.
     *
     * The archive comes FIRST and, when it fails, the delete does NOT happen. A branch we could not
     * archive is a branch whose only remaining copy is the reflog, and the entire point of this change is
     * to stop relying on the reflog. Refusing to delete is the fail-safe direction: the worst case is a
     * branch that survives one more cleanup cycle.
     */
    private deleteOne(
        repoRoot: string,
        verb: MutationVerb,
        entry: DeletableBranch,
        retention: string,
    ): ReapedBranch {
        // SHA first — after the delete there is no branch left to resolve, and the whole point of the
        // audit line is that it records what was destroyed while it still exists.
        const resolved = this.capture(repoRoot, ['rev-parse', entry.branch]);
        const sha = resolved.ok ? resolved.out : '';

        const archive = retention === BRANCH_RETENTION_ARCHIVE_TAG
            ? this.archiver.archive(repoRoot, entry.branch)
            : new ArchiveResult('', sha, true, '');
        if (!archive.ok) return this.archiveFailed(repoRoot, verb, entry, sha, archive);

        const deleted = this.capture(repoRoot, ['branch', '-D', entry.branch]);
        const result = new ReapedBranch(
            entry.branch, sha, entry.reason, entry.pr, deleted.ok, deleted.ok ? '' : deleted.err);
        result.archiveTag = archive.tag;

        const event = new BranchMutationEvent(verb, 'REAP');
        event.fromBranch = entry.branch;
        event.sha = sha;
        event.archiveTag = archive.tag;
        event.outcome = deleted.ok ? `deleted (${entry.reason})` : `FAILED (${deleted.err})`;
        this.mutationLog.logBranchMutation(repoRoot, event);

        return result;
    }

    // Archiving failed ⇒ the branch is NOT deleted. Reported as a failure with git's own words, so the
    // human sees a branch that survived and why, rather than a silent skip.
    private archiveFailed(
        repoRoot: string, verb: MutationVerb, entry: DeletableBranch, sha: string, archive: ArchiveResult,
    ): ReapedBranch {
        const error = `not deleted — could not archive it first: ${archive.error}`;
        const event = new BranchMutationEvent(verb, 'REAP');
        event.fromBranch = entry.branch;
        event.sha = sha;
        event.outcome = `SKIPPED (${error})`;
        this.mutationLog.logBranchMutation(repoRoot, event);
        return new ReapedBranch(entry.branch, sha, entry.reason, entry.pr, false, error);
    }

    /**
     * Write the verdicts back with the reaped branches removed, so the branch-creation-guard's cap
     * sees the post-reap truth on its very next call instead of continuing to block against branches
     * that no longer exist. Anything that FAILED to delete stays in `deletable` — it is still there,
     * and still dead.
     */
    private rewriteCache(repoRoot: string, verdicts: MergedBranchesCache, failed: ReapedBranch[]): void {
        const stillDead = new Set(failed.map((entry: ReapedBranch): string => entry.branch));
        const remaining = verdicts.deletable.filter(
            (entry: DeletableBranch): boolean => stillDead.has(entry.branch));
        this.mergedBranches.writeMergedBranches(
            repoRoot,
            new MergedBranchesCache(verdicts.timestamp, remaining, verdicts.keep, verdicts.worktrees),
        );
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
