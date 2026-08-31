import { injectable, bindingScopeValues } from 'inversify';

import { runPipeline } from './hook-core';
import { denyJson, denyOutcome } from './agent-response';
import { HookArgs, HookOutcome } from './hook-outcome';
import { HookStdinSource, HookStdoutSink, HookProcessExit } from './hook-ports';
import { toError } from '../core/to-error';

// The reason text a crash surfaces to the agent. ONE literal, used by both fail-closed boundaries
// below and worded identically to `denyForCrash`'s so the audit trail reads the same whichever of them
// caught it.
const CRASH_PREFIX = '[ai-hooks] hook crashed unexpectedly — failing closed: ';

/**
 * THE COMPOSITION ROOT'S APP — one PreToolUse invocation, end to end.
 *
 * Production is three lines in `guards-hook.ts` / `rules-hook.ts`:
 *
 *     const container = new Container({ autobind: true });
 *     const app = container.get(HookApp);
 *     await app.run(new HookArgs('guards'));
 *
 * and a test is the SAME three lines with the ports rebound to doubles — canned stdin, a captured
 * stdout, a recorded exit code. That is the whole difference, and it is the point: the test boundary
 * is cut JUST ABOVE the injection point, so the seam a test drives is the seam production drives.
 *
 * What this replaces: `runMain(mode)`, which read stdin itself and reached `process.stdout.write` /
 * `process.exit` from a dozen frames down. `runMain` is DELETED, not kept alongside — two spellings of
 * one entry point is the shim shape this repo rejects outright (see CLAUDE.md, "NO webpieces surface
 * is released backwards-compatible"). Nothing outside this file names it any more.
 *
 * The order of observable effects is unchanged from `runMain`: the invocation's audit line is flushed
 * at the emit boundary inside the pipeline, the decision bytes are written next, and the process exits
 * last through the injected exit port.
 */
@injectable(bindingScopeValues.Singleton)
export class HookApp {
    private readonly stdin: HookStdinSource;
    private readonly stdout: HookStdoutSink;
    private readonly processExit: HookProcessExit;

    constructor(stdin: HookStdinSource, stdout: HookStdoutSink, processExit: HookProcessExit) {
        this.stdin = stdin;
        this.stdout = stdout;
        this.processExit = processExit;
    }

    async run(args: HookArgs): Promise<void> {
        const outcome = await this.decide(args);
        // An ALLOW writes NOTHING — a silent exit 0 is the allow in the PreToolUse protocol, and an
        // empty write would still be a write on a pipe somebody is parsing. Guarded here rather than
        // in the sink so the sink stays a dumb port.
        if (outcome.stdout !== '') this.stdout.write(outcome.stdout);
        this.processExit.exit(outcome.exitCode);
    }

    /**
     * THE FAIL-CLOSED BOUNDARY FOR THE READ ITSELF, and the reason this is a separate method.
     *
     * `runMain` had the stdin read INSIDE the try whose catch produced a deny, so a failure there was
     * still a structured block. Moving the read behind a port would have quietly narrowed that: a
     * rejected read (or anything else thrown before the pipeline starts) would escape `run`, land as an
     * unhandled rejection, and exit non-zero — which PreToolUse reads as a NON-BLOCKING error and lets
     * the tool call THROUGH. That is the exact inversion of "a broken hook never silently lets an edit
     * through", and no golden could catch it, because the goldens substitute this very port.
     *
     * So the try is restored one level out, around the read AND the pipeline, and it emits the same
     * bytes `denyForCrash` emits for a null event.
     */
    private async decide(args: HookArgs): Promise<HookOutcome> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const raw = await this.stdin.read();
            return runPipeline(raw, args.mode);
        } catch (err: unknown) {
            const error = toError(err);
            return denyOutcome(null, `${CRASH_PREFIX}${error.message}`, 'hook-crash');
        }
    }
}

/**
 * THE LAST-RESORT FAIL-CLOSED BOUNDARY: the composition root itself could not run.
 *
 * `new Container(...)` and `container.get(HookApp)` happen BEFORE any HookApp exists to catch for
 * them, so an unresolvable binding (a missing decorator, a stripped `design:paramtypes`) would exit
 * non-zero with a stack on stderr — and a non-zero exit is a non-blocking error, so every guarded tool
 * call would sail through unjudged for as long as the defect lasted. Low probability; total
 * consequence. One shared class rather than a copy in each bin, so the two can never drift.
 *
 * It writes through `process` directly, and that is correct rather than a leak: by construction there
 * is no container here to have handed it a port, and this is the same designated terminal boundary the
 * ports themselves wrap.
 */
export class HookBootFailure {
    report(err: unknown): void {
        const error = toError(err);
        // `null` event ⇒ no `systemMessage`. Deliberate: we never parsed a payload, so we do not know
        // whether this was a Bash call, and inventing the Bash-shaped deny would be a guess.
        // webpieces-disable no-process-exit-outside-main -- the hook's exit code IS the Claude Code PreToolUse protocol (exit 0 + JSON = a block); this is the last-resort terminal boundary, reached only when no container could be built to inject a port.
        process.stdout.write(denyJson(null, `${CRASH_PREFIX}${error.message}`) + '\n');
        // webpieces-disable no-process-exit-outside-main -- same terminal boundary; exiting 0 is what makes this a BLOCK rather than a non-blocking error that lets the tool call through.
        process.exit(0);
    }
}
