import { injectable, bindingScopeValues } from 'inversify';

import { AgentWorktreeLock, AgentWorktreeLockReader } from './agent-worktree-lock';
import {
    AGENT_ACTIVITY_LIVE,
    AGENT_ACTIVITY_UNKNOWN,
    AgentActivity,
    HarnessAgentActivityReader,
} from './harness-agent-activity';
import { DeletableWorktree } from './merged-branch-verdicts';
import { Worktree, WorktreeService } from './worktrees';

/**
 * What a `git worktree lock` DOES to a worktree's cleanup verdict.
 *
 * Separate from agent-worktree-lock.ts (which only parses a lock reason) and from
 * harness-agent-activity.ts (which only asks the harness about an agent): this is the POLICY built on
 * top of that evidence — what stops a reap, what a spared lock is allowed to CLAIM about who took it,
 * and what an overridden one has to leave on the verdict so the reaper knows to clear it.
 *
 * ─── WHY THE POLICY CHANGED ──────────────────────────────────────────────────────────────────────
 * It used to be one question, asked of the kernel: is the pid in the lock reason still running? That
 * pid is the Claude Code SESSION process, shared by every subagent, so the answer was yes for the
 * whole life of a session and every agent worktree was spared forever — nine against a cap of five,
 * with one agent running, each carrying the sentence "that agent is working in here" about agents
 * whose PRs had already merged. Both halves were defects: the reap never happened, and the message
 * asserted something nobody knew.
 *
 * ─── THE DECISION TABLE, AND THE ONE RULE BEHIND IT ──────────────────────────────────────────────
 *
 *      HARNESS STATE MAY ONLY VETO A REAP. IT MAY NEVER LICENSE ONE.
 *
 * The licence comes solely from the branch/commit evidence wp-cleanup already computes and already
 * gets right. So, for a lock this repo can read as the harness's own:
 *
 *   branch evidence does NOT say deletable          → SPARE. The harness is not even consulted; it
 *                                                     cannot promote a spare into a reap.
 *   deletable, but the worktree is DIRTY            → SPARE, unconditionally. Uncommitted or
 *                                                     untracked files are work no archive tag can
 *                                                     bring back. This one overrides everything,
 *                                                     including the explicit flag.
 *   deletable, clean, harness says the agent is
 *   mid-tool-call and writing                       → SPARE. The veto.
 *   deletable, clean, harness says returned /
 *   long-stale / cannot tell                        → judge it on its branch like any unlocked tree,
 *                                                     clearing the lock on the way out.
 *
 * `--ignore-stale-locks` moves ONE line of that table: it lets a locked worktree whose branch is not
 * provably dead be classified on its real branch and commit state anyway (so a zero-commit husk gets
 * reaped and a worktree holding unique commits reaches the numbered block a human can answer). It
 * does not touch the dirty rail or the live-agent veto, because neither of those is what the caller
 * is complaining about when they pass it.
 *
 * ─── SCOPE: AGENT LOCKS ONLY ─────────────────────────────────────────────────────────────────────
 * Every override applies ONLY to a lock this file can read as the harness's own. A lock reason naming
 * anything else — a human's "dean is debugging", or nothing at all — is still an instruction from
 * somebody, and wp-cleanup still obeys it.
 */

/**
 * The exact phrase a spared "we cannot tell" verdict carries, exported so wp-cleanup can spot those
 * worktrees and offer the flag that judges them on their branch instead.
 *
 * ONE spelling, shared: the alternative is the caller re-deriving the same condition from a second
 * copy of the sentence, which is how a message and the code that keys off it drift apart.
 */
export const LOCK_LIVENESS_UNVERIFIABLE = 'whether that agent is still running cannot be verified';

/**
 * The stand-in for "the harness was never asked", used on the paths where asking could not change the
 * answer. It is UNKNOWN, so a caller that consults it anyway still fails safe.
 */
export const HARNESS_NOT_CONSULTED = new AgentActivity(
    AGENT_ACTIVITY_UNKNOWN, 'the harness was not consulted');

// Data-only (per CLAUDE.md, classes for data). Everything `decide` rules on, as one value — see
// `gather`, which is the only thing that builds one outside a test.
export class LockEvidence {
    /** The lock reason verbatim, straight out of `git worktree list --porcelain`. */
    lockReason: string;
    /** What the harness says about the agent named in that reason, or HARNESS_NOT_CONSULTED. */
    activity: AgentActivity;
    /** Does `git status --porcelain` report anything, or could it not answer? Either way: held. */
    workInFlight: boolean;
    /** Why it is held, in git's terms — printed verbatim, because the two reasons differ for a human. */
    workInFlightReason: string;
    /** Is the branch this worktree holds ALREADY provably dead by the ordinary verdicts? */
    branchDeletable: boolean;
    /** The caller said to treat a standing agent lock as no evidence at all. */
    ignoreStaleAgentLocks: boolean;

    constructor(
        lockReason: string,
        activity: AgentActivity,
        workInFlight: boolean,
        workInFlightReason: string,
        branchDeletable: boolean,
        ignoreStaleAgentLocks: boolean,
    ) {
        this.lockReason = lockReason;
        this.activity = activity;
        this.workInFlight = workInFlight;
        this.workInFlightReason = workInFlightReason;
        this.branchDeletable = branchDeletable;
        this.ignoreStaleAgentLocks = ignoreStaleAgentLocks;
    }
}

/**
 * Data-only. The one verdict this file produces: spare or override, the sentence that says WHY, and
 * the agent lock the reaper will have to clear if the worktree goes.
 *
 * ONE class rather than a spare-path method and an override-path method, because the two answers are
 * mutually exclusive readings of the same evidence, and two methods is how they drift apart — which
 * is precisely what happened before: the old spared message and the old stale-lock test were computed
 * from the same pid by different code, and only one of them was ever corrected.
 */
export class LockDecision {
    /** True: leave this worktree alone, and `reason` is the whole story. */
    spare: boolean;
    /** Spared: why it was left. Overridden: the clause appended to the branch's own verdict. */
    reason: string;
    /** The agent lock to clear on the way out — null when nothing may be cleared. */
    lock: AgentWorktreeLock | null;

    constructor(spare: boolean, reason: string, lock: AgentWorktreeLock | null) {
        this.spare = spare;
        this.reason = reason;
        this.lock = lock;
    }
}

@injectable(bindingScopeValues.Singleton)
export class WorktreeLockVerdicts {
    // Defaulted like BranchReaper's collaborators, so the non-DI call sites can just
    // `new WorktreeLockVerdicts()` while inversify still injects the singletons from a container.
    constructor(
        private readonly agentLocks: AgentWorktreeLockReader = new AgentWorktreeLockReader(),
        private readonly harness: HarnessAgentActivityReader = new HarnessAgentActivityReader(),
        private readonly worktrees: WorktreeService = new WorktreeService(),
    ) {}

    /**
     * Collect what `decide` rules on — and, just as deliberately, DECLINE to collect the two
     * expensive facts when they cannot change the answer.
     *
     * `git status --porcelain` and a walk of the harness's state tree are gathered only when a reap
     * is otherwise on the table: the lock is one this repo can read as the harness's own, and either
     * the branch is already provably dead or the caller asked for locks to be ignored. That is not an
     * optimisation dressed up as a rule — harness state may only VETO a reap, never license one, so on
     * a path with no reap to veto there is nothing to ask, and asking would invite a later reader to
     * let the answer decide something.
     */
    gather(tree: Worktree, branchDeletable: boolean, ignoreStaleAgentLocks: boolean): LockEvidence {
        const lock = this.agentLocks.parse(tree.lockReason);
        if (lock === null || (!branchDeletable && !ignoreStaleAgentLocks)) {
            return new LockEvidence(tree.lockReason, HARNESS_NOT_CONSULTED, false, '',
                branchDeletable, ignoreStaleAgentLocks);
        }
        const held = this.worktrees.workInFlight(tree.path);
        return new LockEvidence(
            tree.lockReason, this.harness.activityOf(lock.agent, tree.path), held.held, held.reason,
            branchDeletable, ignoreStaleAgentLocks);
    }

    /**
     * Spare this locked worktree, or judge it on its branch like any unlocked one — with the sentence
     * that says which piece of evidence decided it.
     *
     * The order below IS the decision table in the class header, in the same order, for the same
     * reasons. Read it there.
     */
    decide(evidence: LockEvidence): LockDecision {
        const lock = this.agentLocks.parse(evidence.lockReason);
        if (lock === null) return new LockDecision(true, this.foreignLockReason(evidence.lockReason), null);

        if (!evidence.branchDeletable && !evidence.ignoreStaleAgentLocks) {
            return new LockDecision(true, this.unverifiableReason(lock), null);
        }
        if (evidence.workInFlight) {
            return new LockDecision(true,
                `locked by claude agent ${lock.agent}, and the worktree ${evidence.workInFlightReason} — `
                + 'nothing archives that, so it is left exactly where it is', null);
        }
        if (evidence.activity.state === AGENT_ACTIVITY_LIVE) {
            return new LockDecision(true,
                `locked by claude agent ${lock.agent}, and the Claude Code harness says `
                + `${evidence.activity.detail} — that agent is working in here`, null);
        }
        if (evidence.branchDeletable) {
            return new LockDecision(false,
                `the lock from claude agent ${lock.agent} did not stop this — the worktree is clean, its `
                + `branch is already dead, and ${evidence.activity.detail}`, lock);
        }
        return new LockDecision(false,
            `the lock from claude agent ${lock.agent} was treated as no evidence, as asked`, lock);
    }

    /**
     * WHY a locked worktree was left alone when the lock is NOT the harness's — reporting what the
     * reason SAYS, never who we imagine wrote it.
     *
     * This used to read `locked by a human — do not touch` for every lock in existence, which named an
     * actor nothing in the evidence identifies: the lock reason is the ONLY thing we have, a human may
     * have locked it, so may some other tool, and asserting either is the same defect whichever way it
     * lands.
     */
    private foreignLockReason(lockReason: string): string {
        if (lockReason === '') {
            return 'locked with no reason recorded — nothing says who locked it or why, so it is left alone';
        }
        return `locked, reason "${lockReason}" — that is not a claude agent lock, so who locked it `
            + 'is unknown; left alone';
    }

    /**
     * The sentence that replaced "pid N still running — that agent is working in here".
     *
     * It says only what is known: which agent the reason names, that the pid in it cannot answer the
     * question because it is the shared session process, and that nothing else made the worktree
     * provably dead either. No claim about anybody working — and no claim about the harness, which on
     * this path was deliberately never asked, because its answer could not have changed the outcome.
     */
    private unverifiableReason(lock: AgentWorktreeLock): string {
        return `locked by claude agent ${lock.agent}; ${LOCK_LIVENESS_UNVERIFIABLE} — the recorded pid `
            + `${String(lock.pid)} is the shared Claude Code session process, not the agent's. Its branch `
            + 'is not provably dead either, so it is left alone';
    }

    /**
     * Stamp an overridden verdict with the lock the reap must CLEAR: git refuses to remove a locked
     * worktree, and the reason has to say why a lock is being overridden at all.
     *
     * Applied to every verdict the fall-through can produce, not just the deletable one, because the
     * spared cases are exactly where a human reads the reason and asks "wasn't that locked?".
     */
    annotate(verdict: DeletableWorktree, decision: LockDecision | null): DeletableWorktree {
        if (decision === null || decision.spare || decision.lock === null) return verdict;
        verdict.unlockBeforeRemove = true;
        verdict.reason = `${verdict.reason}; ${decision.reason}`;
        return verdict;
    }
}
