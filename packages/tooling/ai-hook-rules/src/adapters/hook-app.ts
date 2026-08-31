import { injectable, bindingScopeValues } from 'inversify';

import { runPipeline } from './hook-core';
import { HookArgs, HookOutcome } from './hook-outcome';
import { HookStdinSource, HookStdoutSink, HookProcessExit } from './hook-ports';

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
 * last through `process.exit`.
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
        const raw = await this.stdin.read();
        const outcome: HookOutcome = runPipeline(raw, args.mode);
        // An ALLOW writes NOTHING — a silent exit 0 is the allow in the PreToolUse protocol, and an
        // empty write would still be a write on a pipe somebody is parsing. Guarded here rather than
        // in the sink so the sink stays a dumb port.
        if (outcome.stdout !== '') this.stdout.write(outcome.stdout);
        this.processExit.exit(outcome.exitCode);
    }
}
