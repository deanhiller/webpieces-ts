import { injectable, bindingScopeValues } from 'inversify';

import { AgentWorktreeLock, AgentWorktreeLockReader } from './agent-worktree-lock';
import { DeletableWorktree } from './merged-branch-verdicts';
import { Worktree } from './worktrees';

/**
 * What a `git worktree lock` DOES to a worktree's cleanup verdict.
 *
 * Separate from agent-worktree-lock.ts, which only reads a lock reason and asks the kernel about a
 * pid: this is the policy built on top of that evidence — which locks stop a reap, what a spared lock
 * is allowed to claim about who took it, and what a stale one has to leave behind on the verdict so
 * the reaper knows a lock is standing in its way.
 */
@injectable(bindingScopeValues.Singleton)
export class WorktreeLockVerdicts {
    constructor(private readonly agentLocks: AgentWorktreeLockReader = new AgentWorktreeLockReader()) {}

    /**
     * The lock on this worktree was taken by a Claude agent whose process is GONE — or null, meaning
     * the lock is still standing for something and the worktree must be spared.
     *
     * Null covers three genuinely different situations that all end the same way: a live agent, a
     * reason we do not recognise, and no reason at all. `sparedReason` is what tells them apart for
     * the reader; here they are one answer, "do not touch".
     */
    staleAgentLock(tree: Worktree): AgentWorktreeLock | null {
        const lock = this.agentLocks.parse(tree.lockReason);
        if (lock === null) return null;
        return this.agentLocks.isRunning(lock) ? null : lock;
    }

    /**
     * WHY a locked worktree was left alone — reporting what the lock SAYS, never who we imagine wrote
     * it.
     *
     * This used to read `locked by a human — do not touch` for every lock in existence, which was
     * wrong twice over. It was factually wrong about the agent harness's own locks, which is what let
     * every `/full-cycle` worktree pile up forever. And it named an actor nothing in the evidence
     * identifies: the lock reason is the ONLY thing we have, a human may have locked it, so may some
     * other tool, and asserting either is the same defect whichever way it lands.
     *
     * So: name the agent and pid when the reason ASSERTS them, and otherwise quote the reason back
     * verbatim and say plainly that we cannot tell who locked it.
     */
    sparedReason(tree: Worktree): string {
        const lock = this.agentLocks.parse(tree.lockReason);
        if (lock !== null) {
            return `locked by claude agent ${lock.agent}, pid ${String(lock.pid)} still running — `
                + 'that agent is working in here';
        }
        if (tree.lockReason === '') {
            return 'locked with no reason recorded — nothing says who locked it or why, so it is left alone';
        }
        return `locked, reason "${tree.lockReason}" — that is not a claude agent lock, so who locked it `
            + 'is unknown; left alone';
    }

    /**
     * Stamp a verdict with the stale lock on its worktree: the lock has to be CLEARED before git will
     * remove the directory, and the reason has to say why a lock is being overridden at all.
     *
     * Applied to every verdict the fall-through can produce, not just the deletable one, because the
     * spared cases are exactly where a human reads the reason and asks "wasn't that locked?".
     */
    annotate(verdict: DeletableWorktree, lock: AgentWorktreeLock | null): DeletableWorktree {
        if (lock === null) return verdict;
        verdict.unlockBeforeRemove = true;
        verdict.reason = `${verdict.reason}; stale lock from claude agent ${lock.agent}, `
            + `pid ${String(lock.pid)} is gone`;
        return verdict;
    }
}
