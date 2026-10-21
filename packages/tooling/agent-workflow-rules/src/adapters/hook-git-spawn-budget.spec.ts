import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { specTempDirs } from '@webpieces/tooling-testkit';
import { GoldenFixture, GoldenRepoBuilder, REPO_TOKEN } from './hook-app-fixtures';

/**
 * THE GIT-PROCESS BUDGET OF ONE GUARD-HOOK INVOCATION (#1355): ZERO `git` processes.
 *
 * Measured before #1355 with a logging `git` first on PATH, one `wp-ai-guards-hook` invocation ran 15
 * `git` processes for a Bash payload and 13 for an Edit, to answer FIVE questions — the branch, the two
 * git dirs, the toplevel, and whether the policy files are tracked. On macOS every `git` is two execs
 * (the xcrun stub), each one checked by syspolicyd, multiplied by every concurrent agent.
 *
 * The design rule now: git work belongs in the async refresher and at the PR gate, NEVER on the
 * synchronous per-tool-call path. The four location/branch answers are filesystem reads (`GitCheckout`),
 * and policy tracking — a commit-time invariant — is checked by `wp-ci` at the gate, not on config load.
 * This spec pins it so it cannot creep back one "just one rev-parse" at a time.
 *
 * ─── How it counts ─────────────────────────────────────────────────────────────────────────────────
 * The same way the measurement did: a `git` SHIM first on PATH that logs one line per exec and then
 * execs the real git. That counts every process, however it is spawned (`spawnSync('git')`,
 * `execSync('git …')` through a shell, a library) — never a mock of one call shape that the next call
 * site would route around.
 *
 * ─── Why each invocation gets a FRESH module graph ───────────────────────────────────────────────
 * In production every tool call is a new node process, so every process-wide memo starts empty. A spec
 * that ran two invocations in one module graph would let the first one's memo pay for the second.
 * `vi.resetModules()` before each invocation re-evaluates every module, exactly as a new process does —
 * so the FIRST call ever made in a checkout is held to the same budget as every later one.
 */

// The ONE ambient read the golden suite also neutralizes: the committed shim is a generated artifact
// that lags this source by a release, and its drift would turn every payload into an unrelated deny.
vi.mock('../bin/hook-registration', async (importOriginal: () => Promise<typeof import('../bin/hook-registration')>) => {
    const actual = await importOriginal();
    return { ...actual, managedSurfaceDrift: (): readonly string[] => [] };
});

const BUDGET = 0;

/** One measured invocation: the payload's label and every git command line the shim logged. */
class GitSpawnCount {
    readonly label: string;
    readonly commands: readonly string[];

    constructor(label: string, commands: readonly string[]) {
        this.label = label;
        this.commands = commands;
    }
}

/** A tree the hook is invoked in: its label and its absolute root (the payload's cwd). */
class HookTree {
    readonly label: string;
    readonly root: string;

    constructor(label: string, root: string) {
        this.label = label;
        this.root = root;
    }
}

/**
 * The logging `git` first on PATH. Installed only around a counted invocation, so the fixture's own
 * setup git (init, commit, worktree add) is never counted.
 */
class GitSpawnShim {
    private readonly dir: string;
    private readonly log: string;
    private savedPath: string | undefined;

    constructor(scratch: string) {
        this.dir = path.join(scratch, 'shim-bin');
        this.log = path.join(scratch, 'git-spawns.log');
        fs.mkdirSync(this.dir, { recursive: true });
        const shim = path.join(this.dir, 'git');
        fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${this.log}'\nexec '${this.realGit()}' "$@"\n`);
        fs.chmodSync(shim, 0o755);
    }

    install(): void {
        fs.writeFileSync(this.log, '');
        this.savedPath = process.env['PATH'];
        process.env['PATH'] = `${this.dir}${path.delimiter}${this.savedPath ?? ''}`;
    }

    uninstall(): string[] {
        process.env['PATH'] = this.savedPath;
        return fs.readFileSync(this.log, 'utf8').split('\n').filter((line: string) => line !== '');
    }

    // The git the shim hands off to: the first executable `git` on the ORIGINAL PATH.
    private realGit(): string {
        for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
            const candidate = path.join(dir, 'git');
            if (dir !== '' && fs.existsSync(candidate)) return candidate;
        }
        throw new Error('no git on PATH — this spec measures git processes and needs a real git to hand off to');
    }
}

/** Canned harness payloads, in the measured Claude Code envelope (see hook-app-fixtures.ts). */
class Payloads {
    bash(cwd: string, agentId: string): string {
        return JSON.stringify({
            hook_event_name: 'PreToolUse', session_id: 'sess-budget', transcript_path: '/dev/null', cwd,
            agent_id: agentId, agent_type: agentId === '' ? '' : 'general-purpose',
            tool_name: 'Bash', tool_input: { command: 'echo hi' },
        });
    }

    edit(cwd: string): string {
        return JSON.stringify({
            hook_event_name: 'PreToolUse', session_id: 'sess-budget', transcript_path: '/dev/null', cwd,
            tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'f.txt'), old_string: 'hello', new_string: 'bye' },
        });
    }
}

/**
 * ONE invocation through the real composition root, in a FRESH module graph (see the file doc), with
 * only the three process ports substituted — exactly what hook-app-golden.spec.ts drives.
 */
async function invokeFresh(stdin: string): Promise<void> {
    vi.resetModules();
    const runtime = await import('@webpieces/hook-runtime');
    const evaluator = await import('./hook-pipeline-evaluator');
    const inversify = await import('inversify');

    class CannedStdin extends runtime.HookStdinSource {
        override read(): Promise<string> { return Promise.resolve(stdin); }
    }
    class DiscardStdout extends runtime.HookStdoutSink {
        override write(bytes: string): void { void bytes; }
    }
    class RecordedExit extends runtime.HookProcessExit {
        override exit(code: number): void { void code; }
    }

    const container = new inversify.Container({ autobind: true });
    container.bind(runtime.HookEvaluator).to(evaluator.HookPipelineEvaluator);
    container.bind(runtime.HookStdinSource).toConstantValue(new CannedStdin());
    container.bind(runtime.HookStdoutSink).toConstantValue(new DiscardStdout());
    container.bind(runtime.HookProcessExit).toConstantValue(new RecordedExit());
    await container.get(runtime.HookApp).run(new runtime.HookArgs('guards'));
}

describe('wp-ai-guards-hook git-process budget (#1355)', () => {
    const payloads = new Payloads();
    let shim: GitSpawnShim;
    const trees: HookTree[] = [];

    beforeAll(() => {
        const prepared = new GoldenRepoBuilder().build(new GoldenFixture('budget', 'guards', REPO_TOKEN));
        trees.push(new HookTree('primary clone', prepared.repo));
        const linked = path.join(prepared.root, 'linked-wt');
        execFileSync('git', ['-C', prepared.repo, 'worktree', 'add', '-q', '-b', 'dean/fixture-linked', linked], { encoding: 'utf8' });
        trees.push(new HookTree('linked worktree', fs.realpathSync(linked)));
        shim = new GitSpawnShim(specTempDirs.makeReal('wp-git-budget-'));
    });

    afterAll(() => {
        vi.resetModules();
    });

    async function count(label: string, stdin: string): Promise<GitSpawnCount> {
        shim.install();
        let commands: string[] = [];
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the PATH must be restored whatever the invocation does; a throw still propagates
        try {
            await invokeFresh(stdin);
        } finally {
            commands = shim.uninstall();
        }
        return new GitSpawnCount(label, commands);
    }

    it('spends no git process on any invocation, in the primary clone and a linked worktree — the first call included', async (): Promise<void> => {
        const measured: GitSpawnCount[] = [];
        for (const tree of trees) {
            measured.push(await count(`${tree.label} / first call`, payloads.bash(tree.root, '')));
            measured.push(await count(`${tree.label} / Bash`, payloads.bash(tree.root, '')));
            measured.push(await count(`${tree.label} / Bash from a subagent`, payloads.bash(tree.root, 'agent-budget-1')));
            measured.push(await count(`${tree.label} / Edit`, payloads.edit(tree.root)));
        }
        for (const run of measured) {
            expect(run.commands.length, `${run.label} spawned:\n${run.commands.join('\n')}`).toBe(BUDGET);
        }
    });

    it('still spends none when a declared policy file is untracked — that is the PR gate\'s check', async (): Promise<void> => {
        const tree = trees[0];
        execFileSync('git', ['-C', tree.root, 'rm', '-q', '--cached', '--', '.webpieces-config/rules/fixture-0.json'], { encoding: 'utf8' });
        const run = await count('untracked policy', payloads.edit(tree.root));
        expect(run.commands.length, run.commands.join('\n')).toBe(BUDGET);
    });
});
