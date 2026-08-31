/**
 * The WORKTREE removal report, and the one thing in it a human has to be able to act on: WHERE the
 * `recover=` line was written.
 *
 * That message used to carry the literal `.webpieces/logs/branch-mutations.log`. The log is
 * deliberately per-worktree — a linked worktree's lives at
 * `<primary>/.webpieces/worktrees/<name>/logs/` — so the literal named a file that does not exist in
 * half the trees that read it. Removing a worktree deletes REAL FILES; a reader who cds to the printed
 * path and greps nothing concludes the removal was never logged, which is the opposite of the truth.
 *
 * Asserted against `BranchMutationLog.branchMutationLogPath` — the SAME resolver the writer calls — so
 * this compares the message to the answer rather than to a second copy of a string.
 */
import { describe, it, expect } from 'vitest';
import {
    BranchMutationLog,
    CLASSIFICATION_LOCKED,
    DeletableWorktree,
    LOCK_LIVENESS_UNVERIFIABLE,
    MergedBranchesCache,
    MergedBranchesService,
    ReapedWorktree,
    WorktreeReapResult,
    WorktreeReaper,
    WorktreeService,
} from '@webpieces/rules-config';

import { WorktreeCleanupSection } from './worktree-cleanup';
import { FLAG_IGNORE_STALE_LOCKS } from './cleanup-options';

function section(): WorktreeCleanupSection {
    return new WorktreeCleanupSection(
        new MergedBranchesService(), new WorktreeReaper(), new WorktreeService(), new BranchMutationLog());
}

function removed(): WorktreeReapResult {
    const done = new ReapedWorktree('/work/wt-dead', 'dean/dead', 'sha99', 'PR #431 merged', 431, true, '');
    done.branchDeleted = true;
    return new WorktreeReapResult([done], [], []);
}

describe('WorktreeCleanupSection.report', () => {
    it('names the RESOLVED branch-mutation log path, not a relative literal', () => {
        const out = section().report('/repo', removed());

        expect(out).toContain('REAP_WORKTREE');
        expect(out).toContain(new BranchMutationLog().branchMutationLogPath('/repo'));
    });

    /**
     * Two roots, two answers. A report that hard-coded the path would produce the same bytes for both,
     * which is exactly the regression this guards.
     */
    it('answers differently for a different tree', () => {
        const svc = section();

        expect(svc.report('/repo-a', removed())).not.toBe(svc.report('/repo-b', removed()));
    });

    it('says nothing at all when nothing was removed', () => {
        expect(section().report('/repo', new WorktreeReapResult([], [], []))).toBe('');
    });
});

/**
 * The spared block's other job: when a lock was left standing because liveness COULD NOT BE
 * ESTABLISHED, say what the reader can do about it.
 *
 * That half was missing, and its absence is the whole incident — the old message asserted "that agent
 * is working in here" and offered no way past it, so the only route out was a hand-run
 * `git worktree unlock` per directory, seven times.
 */
describe('WorktreeCleanupSection.sparedBlock', () => {
    function locked(reason: string): DeletableWorktree[] {
        return [new DeletableWorktree('/work/wt-a', 'dean/a', reason, 0, false, CLASSIFICATION_LOCKED)];
    }

    it('offers the flag when a claude-agent lock could not be verified', () => {
        const out = section().sparedBlock(
            locked(`locked by claude agent agent-a; ${LOCK_LIVENESS_UNVERIFIABLE} — the recorded pid 42 is `
                + 'the shared Claude Code session process'), []);

        expect(out).toContain('/work/wt-a');
        expect(out).toContain(FLAG_IGNORE_STALE_LOCKS);
    });

    // Not every spared lock is stale. A lock somebody else took is an instruction, and telling the
    // reader to ignore it would be teaching a cure for a problem they do not have.
    it('does NOT offer the flag for a lock that is not a claude agent\'s', () => {
        const out = section().sparedBlock(
            locked('locked, reason "dean is debugging" — that is not a claude agent lock'), []);

        expect(out).toContain('dean is debugging');
        expect(out).not.toContain(FLAG_IGNORE_STALE_LOCKS);
    });

    // A live agent's lock is not unverifiable — it is verified, the other way. No flag hint.
    it('does NOT offer the flag when the harness confirmed the agent is working', () => {
        const out = section().sparedBlock(
            locked('locked by claude agent agent-a, and the Claude Code harness says its transcript ends '
                + 'mid-tool-call — that agent is working in here'), []);

        expect(out).not.toContain(FLAG_IGNORE_STALE_LOCKS);
    });
});

/**
 * The section is the only thing that turns `--ignore-stale-locks` into an argument to the classifier.
 * A flag parsed at the bin, printed in `--help` and then dropped on the floor is the classic failure
 * of a flag added at the edges, and every other assertion in this package would still pass under it.
 */
describe('WorktreeCleanupSection.verdicts', () => {
    class RecordingService extends MergedBranchesService {
        asked: boolean | null = null;

        computeMergedBranches(_repoRoot: string, ignoreStaleAgentLocks: boolean): MergedBranchesCache {
            this.asked = ignoreStaleAgentLocks;
            return new MergedBranchesCache('', [], [], []);
        }
    }

    function ask(ignoreStaleLocks: boolean): boolean | null {
        const service = new RecordingService();
        new WorktreeCleanupSection(
            service, new WorktreeReaper(), new WorktreeService(), new BranchMutationLog())
            .verdicts('/repo', ignoreStaleLocks);
        return service.asked;
    }

    it('hands the classifier exactly what argv said', () => {
        expect(ask(true)).toBe(true);
        expect(ask(false)).toBe(false);
    });
});
