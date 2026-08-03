import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { renderShim, shimPath } from './shim';

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

    /**
     * A repo root staged so the shim's VERSION-DRIFT check (fault D) fires: an installed guard bin, a
     * declared @webpieces/pr-gate pin in package.json, and a different installed version in
     * node_modules. The fake bin prints EXECED, so "the guards actually ran" is observable in stdout —
     * pass matching versions to stage the no-drift case instead.
     *
     * Lives here rather than in one spec because two spec files now need the identical staging, and a
     * second copy is a second definition of what "drift" means.
     */
    stageDriftRoot(declared: string, installed: string): string {
        const root = this.mktmp();
        const binDir = path.join(root, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'wp-ai-guards-hook'), '#!/bin/sh\nprintf EXECED\n', { mode: 0o755 });
        fs.writeFileSync(path.join(root, 'package.json'),
            JSON.stringify({ dependencies: { '@webpieces/pr-gate': declared } }, null, 2) + '\n');
        const manifestDir = path.join(root, 'node_modules', '@webpieces', 'pr-gate');
        fs.mkdirSync(manifestDir, { recursive: true });
        fs.writeFileSync(path.join(manifestDir, 'package.json'),
            JSON.stringify({ name: '@webpieces/pr-gate', version: installed }, null, 2) + '\n');
        return root;
    }

    /**
     * A throwaway repo root that OWNS a committed shim at shimPath(root) with the given contents
     * (null = no shim at all, i.e. a fresh clone / global install). Shared by the two spec files that
     * exercise the committed-shim self-guard, so "a root with a shim in it" has one definition.
     */
    stageCommittedShim(content: string | null): string {
        const root = this.mktmp();
        if (content !== null) {
            const p = shimPath(root);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, content);
        }
        return root;
    }

    /** A Bash tool payload, as Claude Code sends it on stdin. */
    bashPayload(command: string): string {
        return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
    }

    /** A Read payload — the L0 allowlist entry that keeps a broken tree inspectable. */
    readPayload(filePath: string): string {
        return JSON.stringify({ tool_name: 'Read', tool_input: { file_path: filePath } });
    }

    /** A file-tool payload, for the always-allowed webpieces.config.json recovery target. */
    filePayload(toolName: string, filePath: string): string {
        return JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
    }

    /** True when `cmd` matches a POSIX ERE, judged by the SAME `grep -E` the shim itself runs. */
    ereMatches(ere: string, cmd: string): boolean {
        return this.ereMatchSet(ere, [cmd]).matched(cmd);
    }

    /**
     * Which of `cmds` that same `grep -E` matches — answered in ONE grep process for the whole batch.
     *
     * grep is a line matcher, so feeding N commands as N lines asks exactly the question `-Eq` answers
     * per command; the engine, the ERE and the anchors are unchanged. What changes is cost: a process
     * spawn is ~5ms on an idle machine but ~100ms when the suite runs projects in parallel, so a
     * 16-command twin check used to be 16 spawns (~2s of pure spawn latency) for one grep pass. That
     * is what made these files miss the per-test timeout under load.
     */
    ereMatchSet(ere: string, cmds: readonly string[]): EreMatchSet {
        for (const cmd of cmds) {
            // A command carrying a newline would arrive at grep as TWO lines and be judged as two
            // different commands — a silently wrong answer. Nothing in the allowlists does this.
            if (cmd.includes('\n')) throw new Error(`ereMatchSet cannot batch a multi-line command: ${JSON.stringify(cmd)}`);
        }
        const result = spawnSync('grep', ['-E', ere], { input: cmds.join('\n'), encoding: 'utf8' });
        const hits = new Set((result.stdout ?? '').split('\n').filter((line: string): boolean => line !== ''));
        return new EreMatchSet(hits);
    }
}

/** The lines `grep -E` matched in one batched run — ask it per command with {@link matched}. */
export class EreMatchSet {
    private readonly hits: ReadonlySet<string>;

    constructor(hits: ReadonlySet<string>) {
        this.hits = hits;
    }

    matched(cmd: string): boolean {
        return this.hits.has(cmd);
    }
}
