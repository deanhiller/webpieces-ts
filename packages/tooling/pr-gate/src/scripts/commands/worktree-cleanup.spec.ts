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
    MergedBranchesService,
    ReapedWorktree,
    WorktreeReapResult,
    WorktreeReaper,
    WorktreeService,
} from '@webpieces/rules-config';

import { WorktreeCleanupSection } from './worktree-cleanup';

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
