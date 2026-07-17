import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { renderShim } from './shim';

/**
 * The shim's PreToolUse deny payload, as it prints it on stdout. Named (not an inline literal on the
 * JSON.parse cast) so the wire shape this testkit depends on is stated once, in one place.
 */
export class HookSpecificOutput {
    constructor(public readonly permissionDecisionReason: string) {}
}

/** The decision envelope wrapping {@link HookSpecificOutput}. */
export class PreToolUseDecision {
    constructor(public readonly hookSpecificOutput: HookSpecificOutput) {}
}

/** The outcome of one shim invocation. Data-only → a class, per CLAUDE.md. */
export class ShimRun {
    constructor(
        public readonly status: number | null,
        public readonly stdout: string,
        public readonly stderr: string,
    ) {}

    /** True when the shim emitted a PreToolUse deny. */
    isDenied(): boolean {
        return this.stdout.includes('"permissionDecision":"deny"');
    }

    /**
     * The deny REASON, parsed out of the PreToolUse JSON.
     * @throws if this run was not a deny (there is no reason to read).
     */
    denyReason(): string {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        const decision = JSON.parse(this.stdout) as PreToolUseDecision;
        return decision.hookSpecificOutput.permissionDecisionReason;
    }
}

/**
 * ShimTestkit — the shared harness for driving the rendered shim through a REAL /bin/sh.
 *
 * Extracted so setup.spec.ts and shim-drift.spec.ts drive the shim the SAME way instead of each
 * keeping its own copy: the shim's entire contract is "what /bin/sh actually does with it", so two
 * drifting harnesses would silently become two different contracts.
 *
 * An instance class (not module-scope functions) because this is normal source to the linter — only
 * *.spec.ts is exempt from no-function-outside-class, and a testkit should not need a disable comment
 * to exist.
 */
export class ShimTestkit {
    /** A throwaway repo root under the OS temp dir. */
    mktmp(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-setup-'));
    }

    /**
     * Run the rendered shim exactly as Claude Code would: `sh <shim> <bin> ...`, from a repo cwd,
     * piping tool-payload JSON on stdin. spawnSync never throws on non-zero exit.
     */
    runShim(root: string, bin: string, stdin: string): ShimRun {
        // Place the shim at its REAL relative location (<root>/.claude/webpieces/ai-hook.sh) so its
        // self-location (`dirname $0/../..` → <root>) resolves the bin correctly. Run it from a SUBDIR
        // to prove it does not depend on the caller's cwd.
        const shimAbs = path.join(root, '.claude', 'webpieces', 'ai-hook.sh');
        fs.mkdirSync(path.dirname(shimAbs), { recursive: true });
        fs.writeFileSync(shimAbs, renderShim(), { mode: 0o755 });
        const subdir = path.join(root, 'packages', 'deep', 'sub');
        fs.mkdirSync(subdir, { recursive: true });
        const r = spawnSync('/bin/sh', [shimAbs, bin], { cwd: subdir, input: stdin, encoding: 'utf8' });
        return new ShimRun(r.status, r.stdout, r.stderr);
    }

    /** A Bash tool payload, as Claude Code sends it on stdin. */
    bashPayload(command: string): string {
        return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    }

    /** True when `cmd` matches a POSIX ERE, judged by the SAME `grep -E` the shim itself runs. */
    ereMatches(ere: string, cmd: string): boolean {
        return spawnSync('grep', ['-Eq', ere], { input: cmd, encoding: 'utf8' }).status === 0;
    }
}
