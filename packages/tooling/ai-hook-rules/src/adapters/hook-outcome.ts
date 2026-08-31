import { HookMode } from '../core/types';

/**
 * What ONE hook invocation decided, as a value instead of as two side effects.
 *
 * Data class per CLAUDE.md rule 1 — fields only. `stdout` is the EXACT bytes to write (a deny's JSON
 * plus its trailing newline, or '' for an allow, because a silent exit 0 IS the allow) and `exitCode`
 * is the last byte of the PreToolUse contract. Making the decision a value is what lets a test assert
 * the composed pipeline's output without a process to inspect.
 */
export class HookOutcome {
    readonly stdout: string;
    readonly exitCode: number;

    constructor(stdout: string, exitCode: number) {
        this.stdout = stdout;
        this.exitCode = exitCode;
    }
}

/**
 * The arguments one hook binary is invoked with. Today that is only WHICH category of rules to run —
 * `guards` for the git/PR/branch guards, `rules` for the code-style rules — but it is a class rather
 * than a bare string so a second argument is an added field and not a changed signature at every call
 * site. Data class per CLAUDE.md rule 1.
 */
export class HookArgs {
    readonly mode: HookMode;

    constructor(mode: HookMode) {
        this.mode = mode;
    }
}

/**
 * THE HOOK'S TERMINAL CONTROL FLOW, as a throw.
 *
 * `emitAllow()` / `emitDeny()` are reached from a dozen places nested several frames deep inside the
 * pipeline, and every one of them means "this invocation is over, here is its answer". They used to
 * say that by calling `process.stdout.write` + `process.exit(0)` on the spot, which is precisely what
 * made the composed pipeline untestable — the answer never became a value anybody could look at.
 *
 * Throwing carries the same "nothing after this line runs" guarantee (both helpers are still typed
 * `never`) while turning the answer into a HookOutcome that `HookApp` writes and exits with. The
 * ORDER of observable effects is unchanged: the audit line is still flushed at the emit site, the
 * bytes are still written before the exit, and the exit still happens through `process.exit` in
 * production.
 *
 * The ONE thing this shape requires: any `catch` between an emit site and HookApp must RETHROW it
 * rather than treat it as a crash. There is exactly one such catch (the fail-closed boundary in
 * hook-core's `runPipeline`), and it returns the carried outcome.
 */
export class HookTerminated extends Error {
    readonly outcome: HookOutcome;

    constructor(outcome: HookOutcome) {
        super('hook invocation terminated');
        this.outcome = outcome;
    }
}
