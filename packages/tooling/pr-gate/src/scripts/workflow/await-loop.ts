import { injectable, bindingScopeValues } from 'inversify';

import { StageOutputLog } from './stage-output-log';

/**
 * THE BLOCKING WAIT, and why webpieces owns one (issue #874, scoped by #878).
 *
 * ─── IT IS ONE EFFICIENT WAIT, OFFERED — NEVER A TURN-LEVEL INSTRUCTION (issue #902) ───────────────
 * #874 justified this class by asserting a worktree-isolated subagent cannot end its turn, #878
 * corrected that, and #900 measured that the background re-invocation the correction relied on does not
 * reliably fire. #902 settles the shape of the advice: webpieces names the efficient wait and blocks the
 * wasteful poll, and says NOTHING about when an agent should end its turn. An agent already waits on the
 * subagents it spawns, routinely, without being told; a fixed rule in a string cannot see the situation
 * it is ruling on.
 *
 * What this class is for is the case where an agent has decided to block. There, a Bash call is
 * the only pause it can express: `Monitor` does not block (its own result says "Keep working — do not
 * poll or sleep"), and a `Monitor` carrying a real polling loop is refused by the HARNESS, because a
 * `while`/`until` with a redirect cannot be statically proven to stay inside the worktree (178 of 553
 * measured subagent Monitor calls). That refusal is Claude Code's and is not ours to relax.
 *
 * Without either, the agent falls back to `echo .` every three seconds — measured at 920M tokens, 18.3%
 * of every token the fleet spent in the 24h to 2026-09-07, because every turn resends the whole
 * conversation at ~557,000 tokens. This class is the thing that makes that unnecessary, and
 * `wait-spin-guard` is the thing that makes it unused.
 *
 * ─── THREE CONSTRAINTS, all of them the harness's, none of them negotiable ─────────────────────────
 *
 *  1. **What the AGENT TYPES must be a plain command.** No loop, no redirect, no pipe, no command
 *     substitution — those are exactly what the isolation check refuses. All the looping is in here,
 *     inside one process, behind a bare `pnpm wp-await-reviews`.
 *  2. **It must print something roughly every {@link HEARTBEAT_MS}.** The harness backgrounds and then
 *     KILLS a foreground command that has produced no output for 600 seconds, and a killed wait throws
 *     away the wait. Same defence `wp-build` already runs, same `still` word for the same reason: a
 *     tick that has not moved must be distinguishable from a stalled reporter.
 *  3. **It must RETURN before that ceiling on its own**, saying to run it again. A wait that dies at
 *     the watchdog looks like a crash; a wait that returns at {@link CEILING_MS} with "still waiting"
 *     turns a 100-minute wait into ~11 tool calls instead of the ~2,000 an `echo .` loop costs.
 *
 * `done` is a normal, ZERO exit either way. "Still waiting" is not a failure — it is an answer the agent
 * acts on — and making it non-zero would put a red exit code on the healthy path.
 */
@injectable(bindingScopeValues.Singleton)
export class AwaitLoop {
    constructor(private readonly stageConsole: StageOutputLog) {}

    /**
     * Block until `probe` says it is done, or until {@link CEILING_MS} elapses, printing a heartbeat
     * throughout. Returns WHICH of those happened; the caller renders the outcome.
     */
    async run(probe: WaitProbe): Promise<WaitOutcome> {
        const started = Date.now();
        const heartbeat = new WaitHeartbeat(probe.label);
        // `done()` FIRST, before anything is printed. It is what establishes the probe's state, so
        // describing the wait before asking it would report a state nobody has measured — and an
        // already-finished wait must cost nothing at all.
        for (let first = true; ; first = false) {
            if (probe.done()) return new WaitOutcome(true, Date.now() - started);
            const elapsed = Date.now() - started;
            if (elapsed >= CEILING_MS) return new WaitOutcome(false, elapsed);
            // One heartbeat per HEARTBEAT_MS of ELAPSED time, whatever the poll interval — a probe that
            // costs a network round trip is polled far more slowly than one reading a file, and the
            // watchdog counts seconds of silence, not polls.
            if (first || heartbeat.isDue(elapsed)) {
                this.stageConsole.say(`${heartbeat.tick(probe.describe(), elapsed)}\n`);
            }
            await this.sleep(probe.pollMs);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve: () => void): void => {
            setTimeout(resolve, ms);
        });
    }
}

/**
 * WHAT is being waited for. An interface rather than a class because it is business logic — `done()`
 * reads verdict files for one waiter and asks GitHub for the other — and the loop must not know which.
 */
export interface WaitProbe {
    /** Names the wait in every heartbeat line, e.g. `reviewers` / `checks`. */
    readonly label: string;
    /** How long to sleep between two `done()` calls. A file read polls fast; a `gh` call does not. */
    readonly pollMs: number;
    /** True once the wait is over. Called before the first sleep, so an already-finished wait is free. */
    done(): boolean;
    /** The current state, in one short phrase, for the heartbeat: `2 of 4 verdicts in`. */
    describe(): string;
}

/** How the wait ended: satisfied, or out of time. Data-only (a class, per CLAUDE.md). */
export class WaitOutcome {
    done: boolean;
    waitedMs: number;

    constructor(done: boolean, waitedMs: number) {
        this.done = done;
        this.waitedMs = waitedMs;
    }

    /** Whole seconds waited — what every message prints, so nothing formats it twice. */
    get waitedSeconds(): number {
        return Math.round(this.waitedMs / 1000);
    }
}

/**
 * The heartbeat's state: what the probe said on the PREVIOUS tick, so a tick that has not moved can say
 * so. `still` is the load-bearing word, exactly as it is in `BuildLogHeartbeat`: a wait where nothing
 * has happened for two minutes and a wait whose REPORTER has died look identical without it.
 */
export class WaitHeartbeat {
    private previous: string | null = null;
    private nextDueMs = HEARTBEAT_MS;

    constructor(private readonly label: string) {}

    /** True when `elapsedMs` has passed the next heartbeat slot; consumes the slot when it has. */
    isDue(elapsedMs: number): boolean {
        if (elapsedMs < this.nextDueMs) return false;
        this.nextDueMs = elapsedMs + HEARTBEAT_MS;
        return true;
    }

    /** One heartbeat line — `waiting on <label>: <state> (<n>s)`, plus ` still` when it has not moved. */
    tick(state: string, elapsedMs: number): string {
        const still = this.previous !== null && state === this.previous ? ' still' : '';
        this.previous = state;
        return `waiting on ${this.label}: ${state} (${String(Math.round(elapsedMs / 1000))}s)${still}`;
    }
}

/**
 * How often the wait proves it is alive. Hardcoded, like `wp-build`'s: the number that matters is the
 * harness's 600-second silence watchdog, which no repo configures, so a knob here would only ever be a
 * way to set it wrong.
 */
export const HEARTBEAT_MS = 20_000;

/**
 * When the wait gives up and asks to be re-run — comfortably under the harness's 600-second ceiling, so
 * the command always returns its own answer rather than being killed holding one.
 */
export const CEILING_MS = 540_000;
