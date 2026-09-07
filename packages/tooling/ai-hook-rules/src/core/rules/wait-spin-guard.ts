import { dotWebpieces } from '@webpieces/rules-config';

import type { BashContext, Violation } from '../types';
import { Violation as V } from '../types';
import { BashRuleBase, EmptyRuleConfig } from '../rule-base';
import { FixHint } from '../fix-hint';
import { L0_FAULT_NONE } from '../l0-fault-codes';
import { logGuardDecision, GuardDecision, Verdict, MATRIX_L2_UNROWED } from '../decision-log';
import { CommandScanner } from '../command-scan';
import { SessionCallHistory } from '../session-call-history';
import { ShellSegmentScan } from './shell-segment-scan';
import { WaitSpinScan, WaitSpinHit, SPIN_POLL } from './wait-spin-scan';

/**
 * Blocks the two shapes an agent uses to WAIT when it has nothing left to do — a bare `echo .` /
 * `true` / `date` keep-alive, and the same `gh pr checks <n>` asked for the third time — and hands back
 * the ONE blocking command that its kind of agent can actually use instead.
 *
 * ─── The incident, measured (issue #874) ───────────────────────────────────────────────────────────
 * In the 24 hours to 2026-09-07, ten agent runs across four repos spun this way: 920M tokens, 18.3% of
 * every token the fleet spent, ~$1,389. Excluding the single worst run entirely it is still 9.0%. The
 * arithmetic is not subtle — every turn resends the whole conversation, measured at ~557,000 tokens per
 * turn, so a three-second `echo .` costs more than most of the work around it.
 *
 * ─── WHY agents do it, which is the part that decides the cure ─────────────────────────────────────
 * Not laziness, and not a missing instruction. A causal chain with no slack in it:
 *
 *   1. A subagent that stops making tool calls is FINISHED — its run returns to its parent. It cannot
 *      end its turn and be woken up later; ending the turn IS the end of the agent.
 *   2. `Monitor` does not block. Its own result text says "Keep working — do not poll or sleep", which
 *      is precisely what an agent with nothing left to do cannot act on.
 *   3. A `Monitor` with a real polling loop is refused by the HARNESS — 178 of 553 subagent Monitor
 *      calls — because a `while`/`until` with a redirect cannot be statically proven to stay inside the
 *      worktree. That refusal is Claude Code's, not webpieces'; it is not ours to relax and this guard
 *      does not try.
 *   4. So `echo .` every three seconds is the only remaining way to stay alive.
 *
 * A BLOCKING BASH COMMAND is therefore the only wait primitive a worktree-isolated subagent has, which
 * is why `pnpm wp-await-reviews` and `pnpm wp-await-checks` exist and why this guard can afford to
 * refuse: for the first time there is something to refuse INTO.
 *
 * ─── THE CURE DIFFERS BY AGENT KIND, and prescribing the wrong one DESTROYS WORK ───────────────────
 * A main agent can end its turn and be re-invoked by a backgrounded command; that is the cheapest wait
 * there is, and telling it to block a Bash call for ten minutes would be worse advice. A
 * worktree-isolated subagent cannot: "end your turn" kills it mid-wait and loses everything it has
 * done. One cure per kind, and the kind is read the same way the decision log stamps it —
 * `dotWebpieces.worktreeName(root)`, git's own worktree name, empty for the primary clone. Same call,
 * so a `tree=` column and this verdict cannot disagree.
 *
 * ─── It acts UNCONDITIONALLY, and has NO config key ────────────────────────────────────────────────
 * Like `commit-message-substitution-guard` and `build-output-pipe-guard`, and on the same two tests. A
 * NEW key under `hookGuards` is a key every consumer must ADD or have every Bash call blocked on
 * upgrade (fault Y) — that shipped once, with `whole-repo-build-guard`. And there is nothing for a
 * switch to rescue: the cure is available for every input, is strictly better than what was blocked,
 * and can never itself match this guard.
 */
export class WaitSpinGuardRule extends BashRuleBase<EmptyRuleConfig> {
    constructor() {
        // configKey === name and is DELIBERATELY not a real webpieces.config.json key — see the class
        // docstring on fault Y.
        super(new EmptyRuleConfig(), 'wait-spin-guard', 'wait-spin-guard');
    }

    private readonly scan = new WaitSpinScan(new CommandScanner(), new ShellSegmentScan());
    private readonly history = new SessionCallHistory();

    readonly description =
        'Block a Bash call whose whole purpose is to stay alive — a bare echo/true/date keep-alive, or ' +
        'the same gh pr checks/view asked a third time — and name the ONE blocking wait command the ' +
        'calling agent kind can use: pnpm wp-await-reviews / pnpm wp-await-checks for a worktree ' +
        'subagent, a Monitor plus ending the turn for a main agent.';

    get fixHint(): FixHint {
        return new FixHint(
            'This command does nothing except keep your turn alive, and a turn costs your whole context — '
            + '~557,000 tokens measured, whatever the command was.',
            'Wait by BLOCKING on one command instead of by taking turns. The line above names the one '
            + 'that fits the agent you are; it is the only one to run.',
            [],
        );
    }

    check(ctx: BashContext): readonly Violation[] {
        // Blocklist-shaped, so match on commandCode — stripping heredocs and quoted prose can only ever
        // block LESS, and this repo's docs and commit messages are full of these command names.
        const hit = this.scan.classify(ctx.commandCode);
        if (hit === null) return this.allow(ctx, 'not-a-wait-spin');
        if (hit.shape === SPIN_POLL) return this.judgePoll(ctx, hit);
        return this.block(ctx, hit);
    }

    /**
     * ONE `gh pr checks 874` is a snapshot somebody acts on and must stay allowed — the difference
     * between asking a question and refusing to stop asking it is the number of times, and nothing else.
     * So the third identical call is the one refused, and the count comes from this session's own call
     * log (which holds calls 1..N-1 by the time this runs) and fails OPEN when it cannot be read.
     */
    private judgePoll(ctx: BashContext, hit: WaitSpinHit): readonly Violation[] {
        const prior = this.history.priorBashCalls(ctx.workspaceRoot, ctx.command);
        if (prior < REPEATS_BEFORE_REFUSAL) return this.allow(ctx, `poll-${String(prior)}-prior`);
        return this.block(ctx, hit);
    }

    private allow(ctx: BashContext, reason: string): readonly Violation[] {
        this.logDecision(ctx, 'ALLOW', reason);
        return [];
    }

    private block(ctx: BashContext, hit: WaitSpinHit): readonly Violation[] {
        // BLOCK_AI_CURE: the cure is a command the agent runs itself, right now, in place of this one.
        this.logDecision(ctx, 'BLOCK_AI_CURE', `${hit.shape}-${hit.program}`);
        return [new V(1, this.truncate(ctx.command), this.message(ctx, hit))];
    }

    // Short on purpose: it is read mid-wait by an agent that needs the ONE next move.
    private message(ctx: BashContext, hit: WaitSpinHit): string {
        return `Blocked: \`${hit.program}\` ${this.what(hit)}. `
            + 'Every turn resends your whole conversation — ~557,000 tokens measured — so waiting by '
            + 'taking turns is the most expensive thing you can do, and it was 18.3% of all fleet '
            + 'tokens in one measured day.\n\n'
            + this.cure(ctx);
    }

    private what(hit: WaitSpinHit): string {
        return hit.shape === SPIN_POLL
            ? 'has already been run twice in this session with the identical arguments, and the answer '
                + 'has not changed because you have not done anything between the calls'
            : 'does nothing at all — it exists only to keep your turn alive';
    }

    /**
     * The ONE cure for the agent that is actually calling, and never both. See the class docstring: a
     * main agent told to block wastes ten minutes; a subagent told to end its turn is destroyed.
     */
    private cure(ctx: BashContext): string {
        return this.isWorktreeIsolated(ctx) ? SUBAGENT_CURE : MAIN_AGENT_CURE;
    }

    /**
     * A linked worktree means a worktree-isolated subagent — git's own answer, via the same call the
     * decision log's `tree=` column makes. Fails to `false` (the main-agent cure) only when git says
     * this is the primary clone, which is what the primary clone is.
     */
    private isWorktreeIsolated(ctx: BashContext): boolean {
        return dotWebpieces.worktreeName(ctx.workspaceRoot) !== '';
    }

    private truncate(s: string): string {
        const MAX = 120;
        return s.length <= MAX ? s : s.slice(0, MAX) + '…';
    }

    private logDecision(ctx: BashContext, verdict: Verdict, reason: string): void {
        logGuardDecision(
            ctx.workspaceRoot,
            new GuardDecision(
                'wait-spin-guard', 'Bash', ctx.command, '-', verdict, reason,
                '-', L0_FAULT_NONE, MATRIX_L2_UNROWED,
            ),
        );
    }
}

/**
 * How many identical prior calls make the next one a spin. TWO, so the THIRD is refused: one call is a
 * snapshot, two is a re-check after doing something, three in a row with nothing in between is a loop.
 */
export const REPEATS_BEFORE_REFUSAL = 2;

/**
 * The subagent cure. It opens by saying what the agent must NOT do, because "end your turn" is the
 * advice a subagent is most likely to reach for and the one that destroys it.
 */
export const SUBAGENT_CURE =
    'You are a worktree-isolated subagent, so you CANNOT end your turn and be woken up — ending it ends\n'
    + 'your run and loses this work. Block on one command instead. It heartbeats while it waits and\n'
    + 'returns as soon as there is something to do:\n\n'
    + '    pnpm wp-await-reviews          # waiting on reviewer subagents you spawned\n'
    + '    pnpm wp-await-checks --pr <n>  # waiting on CI for a PR\n\n'
    + 'Either one exits before the harness ceiling and tells you to run it again if the wait is longer,\n'
    + 'so a long wait costs about ten calls rather than several hundred.';

/**
 * The main-agent cure. A main agent has the cheaper option — cost nothing while waiting — and telling
 * it to sit inside a blocking command instead would be worse advice than the spin it just wrote.
 */
export const MAIN_AGENT_CURE =
    'You are the main agent, so you have the cheapest wait there is: start a `Monitor` (or run the\n'
    + 'command you are waiting on with run_in_background) and then END YOUR TURN. A backgrounded command\n'
    + 're-invokes you when it exits, and you burn nothing at all in the meantime.';
