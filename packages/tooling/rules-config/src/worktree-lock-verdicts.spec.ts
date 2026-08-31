import { describe, it, expect } from 'vitest';

import {
    AGENT_ACTIVITY_LIVE,
    AGENT_ACTIVITY_RETURNED,
    AGENT_ACTIVITY_UNKNOWN,
    AgentActivity,
} from './harness-agent-activity';
import { CLASSIFICATION_MERGED_PR, DeletableWorktree } from './merged-branch-verdicts';
import {
    HARNESS_NOT_CONSULTED,
    LOCK_LIVENESS_UNVERIFIABLE,
    LockEvidence,
    WorktreeLockVerdicts,
} from './worktree-lock-verdicts';

/**
 * THE DECISION TABLE, one test per row, against the policy in isolation.
 *
 * agent-worktree-lock.spec.ts drives the same rules end-to-end through real git and real verdicts;
 * this file pins the rules THEMSELVES, because the end-to-end spec cannot conjure a live agent, a
 * killed one and a dirty tree in the same run without becoming a fixture factory of its own.
 *
 * The rule every row below serves: HARNESS STATE MAY ONLY VETO A REAP, NEVER LICENSE ONE.
 */

const AGENT = 'agent-a017f6be7c518c68c';
const REASON = `claude agent ${AGENT} (pid 64914 start Thu Aug 20 05:12:29 2026)`;

const LIVE = new AgentActivity(AGENT_ACTIVITY_LIVE, 'its transcript ends mid-tool-call and was written 1 minute ago');
const RETURNED = new AgentActivity(AGENT_ACTIVITY_RETURNED, 'its transcript ends with that agent returning');
const CANNOT_TELL = new AgentActivity(AGENT_ACTIVITY_UNKNOWN, 'its transcript could not be read to the end');

function evidence(
    activity: AgentActivity, dirty: boolean, branchDeletable: boolean, ignoreLocks: boolean,
): LockEvidence {
    return new LockEvidence(
        REASON, activity, dirty, dirty ? 'has uncommitted or untracked files' : '',
        branchDeletable, ignoreLocks);
}

describe('a lock that is NOT the harness\'s own is always obeyed', (): void => {
    it('spares an unrecognised reason, quoting it and attributing it to NOBODY', (): void => {
        const decision = new WorktreeLockVerdicts().decide(new LockEvidence(
            'dean is debugging', HARNESS_NOT_CONSULTED, false, '', true, true));

        expect(decision.spare).toBe(true);
        expect(decision.lock).toBeNull();
        expect(decision.reason).toContain('dean is debugging');
        expect(decision.reason).not.toContain('human');
    });

    // Even `--ignore-stale-locks` does not reach it: that flag says "that AGENT lock is stale", and a
    // lock naming nobody is somebody's instruction, not a leftover.
    it('spares an empty reason even when locks were asked to be ignored', (): void => {
        const decision = new WorktreeLockVerdicts().decide(new LockEvidence(
            '', HARNESS_NOT_CONSULTED, false, '', true, true));

        expect(decision.spare).toBe(true);
        expect(decision.reason).toContain('no reason recorded');
    });
});

describe('the branch evidence is the only thing that can LICENSE a reap', (): void => {
    /**
     * The row that makes the harness un-abusable. With the branch not provably dead there is no reap
     * on the table, so the harness is not even asked — and the spared message says exactly that,
     * rather than the old "pid N still running — that agent is working in here", which asserted
     * something nobody knew about agents whose PRs had already merged.
     */
    it('spares a live-branch worktree without consulting the harness, and claims nothing', (): void => {
        const decision = new WorktreeLockVerdicts().decide(
            evidence(HARNESS_NOT_CONSULTED, false, false, false));

        expect(decision.spare).toBe(true);
        expect(decision.reason).toContain(LOCK_LIVENESS_UNVERIFIABLE);
        expect(decision.reason).toContain('shared Claude Code session process');
        expect(decision.reason).not.toContain('still running —');
        expect(decision.reason).not.toContain('working in here');
    });

    it('overrides the lock when the branch is already dead and the agent has returned', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(RETURNED, false, true, false));

        expect(decision.spare).toBe(false);
        expect(decision.lock?.agent).toBe(AGENT);
    });

    // "Cannot tell" is not a veto. It cannot be: an unreadable `~/.claude` would otherwise restore the
    // exact accumulation this change exists to end.
    it('overrides the lock when the branch is dead and the harness could not answer', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(CANNOT_TELL, false, true, false));

        expect(decision.spare).toBe(false);
    });
});

describe('the two vetoes', (): void => {
    // The case the lock exists for, and the one that must never regress: uncommitted or untracked
    // files are work no archive tag captures.
    it('spares a DIRTY worktree even when its branch is merged AND locks were asked to be ignored', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(RETURNED, true, true, true));

        expect(decision.spare).toBe(true);
        expect(decision.reason).toContain('uncommitted or untracked files');
    });

    it('spares a worktree whose agent the harness still reports as mid-tool-call', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(LIVE, false, true, false));

        expect(decision.spare).toBe(true);
        expect(decision.reason).toContain('working in here');
        expect(decision.reason).toContain('mid-tool-call');
    });

    it('spares a live agent even when locks were asked to be ignored', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(LIVE, false, true, true));

        expect(decision.spare).toBe(true);
    });
});

describe('--ignore-stale-locks', (): void => {
    /**
     * What the flag actually moves: a locked worktree whose branch is NOT provably dead stops being
     * hidden behind CLASSIFICATION_LOCKED and gets judged on its real branch and commit state — which
     * is how a zero-commit husk reaches the husk reap and a worktree holding unique commits reaches
     * the numbered block a human can answer. It replaces N hand-run `git worktree unlock`s.
     */
    it('lets a locked worktree with a live-looking branch be judged on that branch', (): void => {
        const decision = new WorktreeLockVerdicts().decide(
            evidence(CANNOT_TELL, false, false, true));

        expect(decision.spare).toBe(false);
        expect(decision.reason).toContain('treated as no evidence, as asked');
        expect(decision.lock?.agent).toBe(AGENT);
    });
});

describe('annotate', (): void => {
    it('marks an overridden verdict for unlocking and appends WHY', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(RETURNED, false, true, false));
        const verdict = new DeletableWorktree(
            '/tree', 'dean/landed', 'PR #999 merged', 999, true, CLASSIFICATION_MERGED_PR);

        new WorktreeLockVerdicts().annotate(verdict, decision);

        expect(verdict.unlockBeforeRemove).toBe(true);
        expect(verdict.reason).toContain('PR #999 merged');
        expect(verdict.reason).toContain(AGENT);
    });

    // A SPARED decision must never license the reaper to clear a lock — the two halves are computed
    // from one decision object precisely so they cannot disagree.
    it('leaves a spared verdict alone, lock untouched', (): void => {
        const decision = new WorktreeLockVerdicts().decide(evidence(LIVE, false, true, false));
        const verdict = new DeletableWorktree('/tree', 'dean/x', 'spared', 0, false, CLASSIFICATION_MERGED_PR);

        new WorktreeLockVerdicts().annotate(verdict, decision);

        expect(verdict.unlockBeforeRemove).toBe(false);
        expect(verdict.reason).toBe('spared');
    });
});
