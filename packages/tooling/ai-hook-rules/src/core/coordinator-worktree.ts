import { EffectiveTree } from './effective-tree';
import { ReadOnlyInspectionScan } from './read-only-inspection';

/**
 * WHO is making this tool call — the coordinator (the main agent loop) or a subagent?
 *
 * The PreToolUse payload carries `agent_id` / `agent_type` ONLY when the hook fires inside a SUBAGENT.
 * Absent means the coordinator. That is the whole signal; there is no positive "I am the coordinator"
 * field to read, so this class exists to make the absence explicit rather than an inline `?? ''`.
 *
 * Data-only (per CLAUDE.md, classes for data) — `coordinator` is derived once in the constructor, the
 * same way EffectiveTree derives `redirected`.
 */
export class AgentIdentity {
    /** Empty when the hook fired in the coordinator. */
    readonly agentId: string;
    /** Empty when the hook fired in the coordinator. */
    readonly agentType: string;
    readonly coordinator: boolean;
    /**
     * WHERE this caller's audit lines belong — the `agents/<id>` namespace under the tree's log
     * directory, or '' meaning "the coordinator's plain log paths, exactly as they have always been".
     *
     * Empty for the coordinator (its paths must not move) AND for the UNKNOWN sentinel (a caller that
     * cannot tell who it is must not be guessed into a namespace, the same fail-open UNKNOWN_AGENT
     * already applies to the block decision). Sanitising it into a safe path segment is dotWebpieces'
     * job, not this class's — see agentDirName.
     */
    readonly logNamespace: string;
    /**
     * WHO the audit line says made the call — `coordinator`, the subagent's id, or `unknown` for a
     * caller that cannot tell. Distinct from {@link logNamespace} on purpose: the sentinel and the
     * coordinator share a log DIRECTORY (nothing may move the coordinator's paths) but they are not the
     * same claim, and a log that conflated them would be asserting something it does not know.
     */
    readonly logLabel: string;

    constructor(agentId: string, agentType: string, identified: boolean = true) {
        this.agentId = agentId;
        this.agentType = agentType;
        this.coordinator = agentId === '' && agentType === '';
        this.logNamespace = this.coordinator || !identified ? '' : agentId;
        this.logLabel = this.coordinator ? 'coordinator' : agentId;
    }
}

/**
 * The default for every caller that cannot tell — library consumers, the openclaw adapter, and every
 * existing runBash() call site. It reads as NOT the coordinator on purpose: only the Claude Code
 * adapter parses the payload that carries the answer, and a caller who does not know must never be
 * GUESSED into a block. Fail open; the one caller that knows passes the real identity.
 *
 * `identified: false` carries that same "we do not know" into the LOG destination, where the fail-open
 * answer is the opposite shape: not a namespace of its own, but the coordinator's existing paths.
 */
export const UNKNOWN_AGENT = new AgentIdentity('unknown', 'unknown', false);

/**
 * L1: the COORDINATOR must not work inside a linked worktree — it must delegate that work to a
 * subagent bound to the worktree.
 *
 * THE INCIDENT (reproduced from a transcript). The coordinator ran `git worktree add ../l2-matrix-doc`,
 * `cd`'d in, and worked there for the rest of the session. Its governance stayed anchored to the
 * PRIMARY clone — `$CLAUDE_PROJECT_DIR` is fixed at session start and does not follow a `cd` — while
 * its filesystem was in the worktree. An L0 version-drift fault then fired against the PRIMARY
 * (pin 0.4.545 vs node_modules 0.4.526) and prescribed `pnpm install`; that install ran in the
 * WORKTREE, which was internally consistent at 0.4.526/0.4.526, so it succeeded, changed nothing in
 * the measured tree, and the guard re-denied. Five identical installs later the agent had invented a
 * false theory ("the harness is stripping my cd prefix") and handed the problem to the human.
 *
 * The cure is not a better message on that fault — it is upstream of it: a split between the tree the
 * agent stands in and the tree that governs it must not be reachable at all. A subagent bound to the
 * worktree has both in one place, so the project stays governed consistently.
 *
 * SCOPE, deliberately narrow:
 *   - `kind === 'worktree'` only. `'primary'` is home; `'foreign'` and `'outside'` are other
 *     jurisdictions and this guard leaves their classification exactly as it was.
 *   - subagents are never blocked — one pinned to a worktree is the CORRECT pattern.
 *   - reading is never blocked. The Read tool never reaches here, and a provably-inert inspection
 *     command is allowed through so the coordinator can still look around before it delegates.
 *
 * NOT in scope, and not a hole: the L0 cure allowlist runs BEFORE this in runBashInternal, so
 * `cd <worktree> && pnpm install` — the literal command from the incident — still passes. That is the
 * invariant L0 exists to hold (a cure must stay reachable), and it is fine: what this guard removes is
 * the session shape in which running that install in the wrong tree was ever plausible.
 */
export class CoordinatorWorktreeGuard {
    private readonly inspection = new ReadOnlyInspectionScan();

    /** The deny report, or null to allow. */
    block(command: string, tree: EffectiveTree, agent: AgentIdentity): string | null {
        if (!agent.coordinator) return null;
        if (tree.kind !== 'worktree') return null;
        if (this.inspection.isReadOnlyInspection(command)) return null;
        return this.report(tree);
    }

    // Short on purpose — main landed a deliberate L0 message diet (384cdae) and these blocks regress
    // straight back to a wall of text if each new one argues its case. State the block, name the
    // worktree, prescribe the subagent, list the read-only escapes. Nothing else.
    private report(tree: EffectiveTree): string {
        return [
            `❌ You are the COORDINATOR and this command works inside linked worktree ${tree.root}.`,
            `   Your governance is anchored to ${tree.governedRoot} and does NOT follow a \`cd\`, so working`,
            `   here splits your filesystem from your guards — the failure that burned five no-op installs.`,
            '',
            '   Spawn a subagent bound to that worktree and work through it: the Agent tool with worktree',
            `   isolation, or have the subagent call EnterWorktree with path: ${tree.root}`,
            '',
            `   You can still READ from here without moving: the Read tool, \`git -C ${tree.root} <cmd>\`,`,
            '   or `git show <branch>:<file>`.',
        ].join('\n');
    }
}
