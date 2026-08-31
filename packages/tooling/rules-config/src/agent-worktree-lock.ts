import { injectable, bindingScopeValues } from 'inversify';

/**
 * Reading the LOCK REASON off a worktree — and NOTHING else.
 *
 * WHY this exists: `git worktree lock` used to mean one thing — a human said "do not touch" — and
 * wp-cleanup spared every locked worktree on that basis. In the agent era that assumption is simply
 * wrong. The Claude Code harness locks EVERY worktree it opens for a subagent, and it writes a
 * machine-readable reason while doing so:
 *
 *     locked claude agent agent-a017f6be7c518c68c (pid 64914 start Thu Aug 20 05:12:29 2026)
 *
 * So every `/full-cycle` run left its worktree behind forever, reported as "locked by a human — do not
 * touch" about a human who has never locked a worktree in his life.
 *
 * THE PID IN THAT REASON PROVES NOTHING, AND THIS FILE NO LONGER ASKS THE KERNEL ABOUT IT.
 * Subagents are not separate OS processes — every agent in a session records the SAME pid, the pid of
 * the Claude Code session itself — so `process.kill(pid, 0)` reduced to "is the editor still open?",
 * which is true by construction for the whole life of a session. That check is why nine worktrees
 * piled up against a cap of five with ONE agent running, each reported as "that agent is working in
 * here" while several of their PRs had already merged. It is deleted, not softened: a heuristic that
 * is right by accident and wrong by construction has no safe residual use.
 *
 * The pid is still PARSED and still PRINTED, because it is what the reason says and a reader deserves
 * to see it — but it is presented as the shared session pid it is, never as evidence of an agent.
 * Liveness now comes from HarnessAgentActivityReader, which asks the harness about the AGENT.
 */

/**
 * The Claude Code harness's lock reason. Anchored at the start so a reason that merely MENTIONS an
 * agent (a human writing "leave this, the claude agent is mid-run") is not mistaken for the harness's
 * own machine-written string; unanchored at the end so a future harness may append to it without this
 * silently reverting to "human lock". `start` is optional for the same reason.
 */
const AGENT_LOCK_REASON = /^claude agent (\S+) \(pid (\d+)(?:\s+start\s+([^)]*))?\)/;

// Data-only (per CLAUDE.md, classes for data). One parsed agent lock.
export class AgentWorktreeLock {
    /** The harness's own name for the agent, e.g. `agent-a017f6be7c518c68c`. */
    agent: string;
    /**
     * The pid the harness recorded. This is the SESSION process, shared by every subagent in that
     * session — printed as a fact about the lock reason, never interrogated. See the file header.
     */
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
}
