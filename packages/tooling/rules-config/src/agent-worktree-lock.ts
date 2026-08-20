import { injectable, bindingScopeValues } from 'inversify';

import { toError } from './to-error';

/**
 * Reading the LOCK REASON off a worktree, and deciding whether the thing that wrote it still exists.
 *
 * WHY this exists: `git worktree lock` used to mean one thing — a human said "do not touch" — and
 * wp-cleanup spared every locked worktree on that basis. In the agent era that assumption is simply
 * wrong. The Claude Code harness locks EVERY worktree it opens for a subagent, and it writes a
 * machine-readable reason while doing so:
 *
 *     locked claude agent agent-a017f6be7c518c68c (pid 64914 start Thu Aug 20 05:12:29 2026)
 *
 * So every `/full-cycle` run left its worktree behind forever, reported as "locked by a human — do not
 * touch" about a human who has never locked a worktree in his life. That is the exact accumulation
 * wp-cleanup exists to prevent, and the message was a lie on top of it.
 *
 * The reason string carries a PID, which is the whole fix: an agent lock whose process is gone is a
 * lock nobody is behind, and the worktree underneath it can be judged on its branch like any other.
 *
 * THE ASYMMETRY IS DELIBERATE AND RUNS ONE WAY. Sparing a dead agent's worktree costs a leftover
 * directory that the next cleanup collects. Reaping a LIVE agent's worktree destroys work in flight.
 * So every uncertainty — an unparseable reason, a pid we cannot interrogate, a permission error —
 * resolves to ALIVE, and alive means spared. Nothing here ever reaps on a guess.
 */

/**
 * The Claude Code harness's lock reason. Anchored at the start so a reason that merely MENTIONS an
 * agent (a human writing "leave this, the claude agent is mid-run") is not mistaken for the harness's
 * own machine-written string; unanchored at the end so a future harness may append to it without this
 * silently reverting to "human lock". `start` is optional for the same reason.
 */
const AGENT_LOCK_REASON = /^claude agent (\S+) \(pid (\d+)(?:\s+start\s+([^)]*))?\)/;

// The one errno that PROVES a pid is gone. Everything else means alive, or means we could not ask.
const NO_SUCH_PROCESS = 'ESRCH';

// Data-only (per CLAUDE.md, classes for data). One parsed agent lock.
export class AgentWorktreeLock {
    /** The harness's own name for the agent, e.g. `agent-a017f6be7c518c68c`. */
    agent: string;
    /** The pid the harness recorded for that agent's process. */
    pid: number;
    /** The `start <date>` text verbatim, or '' when the reason carried none. Printed, never parsed. */
    startedAt: string;

    constructor(agent: string, pid: number, startedAt: string) {
        this.agent = agent;
        this.pid = pid;
        this.startedAt = startedAt;
    }
}

@injectable(bindingScopeValues.Singleton)
export class AgentWorktreeLockReader {
    /**
     * The parsed agent lock, or null when this reason was written by anything other than the Claude
     * Code harness — including the empty reason `git worktree lock` writes with no `--reason`. Null
     * means "spare it, and say only what the reason says" — somebody locked this and the evidence does
     * not identify who.
     */
    parse(lockReason: string): AgentWorktreeLock | null {
        const match = AGENT_LOCK_REASON.exec(lockReason.trim());
        if (match === null) return null;
        const pid = Number.parseInt(match[2], 10);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        return new AgentWorktreeLock(match[1], pid, (match[3] ?? '').trim());
    }

    /**
     * Is the agent that took this lock still running?
     *
     * `process.kill(pid, 0)` sends no signal — it only asks the kernel whether the pid is addressable.
     * ESRCH is the ONE answer that proves death. EPERM proves the opposite (the process exists, it just
     * belongs to somebody else), and any other outcome is a question we could not ask, which under the
     * asymmetry above is answered ALIVE.
     *
     * PID REUSE is a known and ACCEPTED imprecision: an unrelated process may inherit a long-dead
     * agent's pid, and this will then report the worktree as live and spare it forever. That is the
     * safe direction — one directory survives to a cleanup run after the recycled process exits — and
     * the alternative (dating the lock, sniffing the process table for a claude binary) is a pile of
     * platform-specific guessing on the side where being wrong destroys work.
     */
    isRunning(lock: AgentWorktreeLock): boolean {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            process.kill(lock.pid, 0);
            return true;
        } catch (err: unknown) {
            const error = toError(err);
            return (error as NodeJS.ErrnoException).code !== NO_SUCH_PROCESS;
        }
    }
}
