import { injectable, bindingScopeValues } from 'inversify';

/**
 * THE THREE PROCESS COUPLINGS OF THE HOOK — as injectable seams.
 *
 * Why they exist at all: the hook's real contract is a PIPELINE — `stdin -> parse -> adapter -> runner
 * -> emit -> exit` — and until this file existed there was no way to drive that pipeline from a test.
 * `runMain` read `process.stdin` itself and the emit boundary called `process.stdout.write` /
 * `process.exit` directly, so the only testable units were the pure functions UNDERNEATH the pipeline.
 * Tests therefore sat too low: they moved every time the composition was refactored (the AgentHookEvent
 * refactor rewrote `agent-response.spec.ts`'s call sites wholesale) and they proved nothing about the
 * composed bytes.
 *
 * The boundary is cut JUST ABOVE THE INJECTION POINT: production is
 * `new Container({autobind:true}).get(HookApp).run(new HookArgs('guards'))`, and a test builds the same
 * container with these three classes rebound to doubles. That is the whole difference between the two.
 * NOT a spawned process (too high — slow, and nothing can be substituted), NOT the pure helpers
 * underneath (too low — they move under every refactor).
 *
 * THREE, and no more. The rule engine, the adapters, the filesystem and git are NEVER substituted —
 * substituting any of them would leave the golden tests asserting the shape of the test harness rather
 * than the shape of the pipeline, which is the failure mode this whole seam exists to escape.
 *
 * They also stay OFF the L0 recovery path. `src/bin/install-entry.ts` and `src/bin/shim.ts` import
 * nothing but `fs`/`path` on purpose, so a corrupt `node_modules` still yields a clean fault code
 * instead of a crash; an inversify import reachable from either would turn a diagnosable fault into an
 * opaque one. The container lives in the two hook entry points and HookApp, and nowhere else.
 *
 * CLASSES, not interfaces, and that is the DI convention winning over the "behavior is an interface"
 * rule: this repo injects BY TYPE and forbids `Symbol()` DI tokens (`no-symbol-di-tokens`), and an
 * interface is not a runtime value, so it cannot BE the token. A test double therefore `extends` the
 * port and overrides the one method. See CLAUDE.md section 5.
 */
@injectable(bindingScopeValues.Singleton)
export class HookStdinSource {
    /**
     * The PreToolUse payload, byte for byte as the harness wrote it.
     *
     * Moved here verbatim from `hook-core.readStdin()` — same encoding, same three listeners, same
     * "resolve('') on error or on a TTY" behaviour, so an empty read still means "nothing to judge"
     * and never a hang.
     */
    read(): Promise<string> {
        return new Promise((resolve: (value: string) => void) => {
            let data = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (chunk: string) => { data += chunk; });
            process.stdin.on('end', () => { resolve(data); });
            process.stdin.on('error', () => { resolve(''); });
            if (process.stdin.isTTY) resolve('');
        });
    }
}

@injectable(bindingScopeValues.Singleton)
export class HookStdoutSink {
    /**
     * The PreToolUse decision bytes. A deny is JSON + '\n' on STDOUT; an allow writes NOTHING — the
     * protocol reads a silent exit 0 as "allow". See agent-response.ts for the wire shape itself.
     */
    write(bytes: string): void {
        process.stdout.write(bytes);
    }
}

@injectable(bindingScopeValues.Singleton)
export class HookProcessExit {
    /**
     * The hook's exit code IS the Claude Code PreToolUse protocol: exit 0 + JSON on stdout is a deny,
     * silent exit 0 is an allow, and exit 2 would make Claude ignore stdout entirely. So the exit is
     * not incidental plumbing to be tidied away — it is the last byte of the contract, which is
     * exactly why it is a port and not a bare call.
     */
    exit(code: number): void {
        // webpieces-disable no-process-exit-outside-main -- hook exit-code IS the Claude Code PreToolUse protocol (exit 0 + JSON = the contract); this class is the designated terminal boundary, injected so a test can record the code instead of killing the worker.
        process.exit(code);
    }
}
