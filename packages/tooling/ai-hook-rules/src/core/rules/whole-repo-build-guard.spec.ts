import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The guard shells out ONLY to expand `$(git …)` inside the configured build command. Pin it so the
// resolved-command assertions are about the guard's substitution, not this checkout's sha.
vi.mock('child_process', () => ({
    execSync: (): string => 'abc1234def\n',
}));

// The decision log writes to disk; silence it so these tests never touch the fs. MATRIX_L2_UNROWED is a real
// value the guard passes through, so it is re-exported from the original rather than stubbed.
type DecisionLogModule = typeof import('../decision-log');
vi.mock('../decision-log', async (importActual: () => Promise<DecisionLogModule>) => {
    const actual = await importActual();
    return {
        ...actual,
        logGuardDecision: (): void => undefined,
    };
});

import { DEFAULT_MAX_CONCURRENT_BUILDS, HomeConfig, HomeConfigService, InformAiError } from '@webpieces/rules-config';
import { BashContext } from '../types';
import { WholeRepoBuildGuardRule } from './whole-repo-build-guard';

const GATE_COMMAND = 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)';

// The guard is OFF unless ~/.webpieces/config.json opts IN with an explicit `true`. Pinning the home
// config here keeps the suite off the developer's real one — a test that reads personal preferences
// passes or fails by accident, and a test that WRITES one destroys work — and makes each test state the
// switch it is exercising rather than inheriting it. Nothing in this file touches a real HOME.
// HomeConfig(wholeRepoBuildGuard, orphanDirSweep, maxConcurrentBuilds).
function pinHomeConfig(wholeRepoBuildGuard: boolean): void {
    vi.spyOn(HomeConfigService.prototype, 'load')
        .mockReturnValue(new HomeConfig(wholeRepoBuildGuard, false, DEFAULT_MAX_CONCURRENT_BUILDS));
}

// Most of this suite is about WHICH commands the guard refuses, which is only observable on a machine
// that opted in — so the opt-in is pinned here, out loud, rather than being anybody's default.
beforeEach(() => { pinHomeConfig(true); });
afterEach(() => { vi.restoreAllMocks(); });

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

// A command run somewhere OTHER than the workspace root — the one input that changes how a bare
// `pnpm test` is judged.
function ctxInSubdir(command: string): BashContext {
    return new BashContext(command, '/repo', '/repo/apps/site');
}

function guard(): WholeRepoBuildGuardRule {
    // The runner passes commands.pr-gate.buildCommand straight to the constructor; the spec does the same.
    return new WholeRepoBuildGuardRule(GATE_COMMAND);
}

function blocked(command: string): boolean {
    return guard().check(ctx(command)).length === 1;
}

describe('whole-repo-build-guard blocks a build of the world, in every spelling', () => {
    it('blocks build-all under every package manager and wrapper', () => {
        expect(blocked('pnpm run build-all')).toBe(true);
        expect(blocked('npm run build-all')).toBe(true);
        expect(blocked('yarn build-all')).toBe(true);
        expect(blocked('pnpm build-all')).toBe(true);
        expect(blocked('time pnpm run build-all')).toBe(true);
        expect(blocked('pnpm exec build-all')).toBe(true);
    });

    // build-all delegates to these. Blocking the alias while leaving the thing it delegates to open is
    // a guard with a labelled side door — an agent finds it in one `cat package.json`.
    it('blocks the commands build-all itself delegates to', () => {
        expect(blocked('pnpm run webpieces:ci')).toBe(true);
        expect(blocked('pnpm wp-ci')).toBe(true);
        expect(blocked('wp-ci')).toBe(true);
    });

    it('blocks an unnarrowed nx run-many, however it is invoked', () => {
        expect(blocked('pnpm nx run-many -t ci')).toBe(true);
        expect(blocked('npx nx run-many --target=build')).toBe(true);
        expect(blocked('pnpm exec nx run-many -t test --all')).toBe(true);
        expect(blocked('./node_modules/.bin/nx run-many -t lint')).toBe(true);
        expect(blocked('nx run-many -t test --parallel=8')).toBe(true);
    });

    // `--all` is explicit about being the whole workspace, so it is blocked even WITH a project list.
    it('blocks nx run-many --all', () => {
        expect(blocked('pnpm nx run-many -t test --all')).toBe(true);
    });

    it('blocks nx affected with no --base', () => {
        expect(blocked('pnpm nx affected --target=ci')).toBe(true);
        expect(blocked('nx affected -t test')).toBe(true);
    });

    it('blocks a bare workspace-wide nx target', () => {
        expect(blocked('pnpm nx test')).toBe(true);
        expect(blocked('nx test')).toBe(true);
        expect(blocked('pnpm exec nx build')).toBe(true);
    });

    it('blocks a bare vitest run — no path means every spec in the repo', () => {
        expect(blocked('pnpm exec vitest run')).toBe(true);
        expect(blocked('npx vitest run')).toBe(true);
        expect(blocked('pnpm vitest')).toBe(true);
        expect(blocked('pnpm exec vitest run --reporter dot')).toBe(true);
    });

    // The root `test` script IS `vitest run`. Only at the root, where that is what it means.
    it('blocks a bare pnpm test at the workspace root, but not in a project directory', () => {
        expect(blocked('pnpm test')).toBe(true);
        expect(guard().check(ctxInSubdir('pnpm test')).length).toBe(0);
    });

    it('blocks a whole-repo build hidden mid-chain', () => {
        expect(blocked('git status && pnpm run build-all')).toBe(true);
    });
});

describe('whole-repo-build-guard leaves narrow work alone', () => {
    // The single most important test in the file: the command the guard's own message hands out must
    // not trip the guard, or an agent that followed the instructions is told it did not.
    it('allows the gate command the refusal prints — including its $(git merge-base …)', () => {
        expect(blocked(GATE_COMMAND)).toBe(false);
        expect(blocked('pnpm nx affected --target=ci --base origin/main')).toBe(false);
        expect(blocked('pnpm nx affected -t ci --base=abc123')).toBe(false);
    });

    /**
     * `pnpm wp-build` is the ONE command the refusal now hands out, and it runs
     * `commands.pr-gate.buildCommand` through the gate's own resolver. A guard that blocked its own cure
     * would be worse than no guard: the agent follows the instruction and is refused for obeying.
     */
    it('allows pnpm wp-build — the command its own refusal prints', () => {
        expect(blocked('pnpm wp-build')).toBe(false);
        expect(blocked('wp-build')).toBe(false);
        expect(blocked('pnpm exec wp-build')).toBe(false);
        expect(blocked('./node_modules/.bin/wp-build')).toBe(false);
    });

    it('allows a single project or target', () => {
        expect(blocked('nx run core-util:test')).toBe(false);
        expect(blocked('pnpm exec nx run core-util:test')).toBe(false);
        expect(blocked('pnpm nx run architecture:generate')).toBe(false);
        expect(blocked('nx test core-util')).toBe(false);
    });

    it('allows an explicitly narrowed run-many', () => {
        expect(blocked('nx run-many -t test -p core-util core-context')).toBe(false);
        expect(blocked('pnpm nx run-many --target=ci --projects=core-util')).toBe(false);
        // The selector rides on the RUNNER here, not on nx — both spellings must count as narrowing.
        expect(blocked('pnpm --filter core-util test')).toBe(false);
        expect(blocked('pnpm --filter=core-util test')).toBe(false);
    });

    it('allows a path-scoped or project-scoped vitest', () => {
        expect(blocked('pnpm exec vitest run packages/core/core-util')).toBe(false);
        expect(blocked('pnpm exec vitest run packages/tooling/ai-hook-rules/src/core/rules')).toBe(false);
        expect(blocked('pnpm exec vitest run --project core-util')).toBe(false);
        expect(blocked('pnpm exec vitest related src/foo.ts')).toBe(false);
    });

    // A workspace-wide REGENERATION is not a build of the world, and this repo's own docs prescribe it
    // (`nx run-many --target=di-graph-generate`, then commit the result). Blocking it would make the
    // guard wrong about a command an agent is required to run.
    it('allows a workspace-wide run-many of a non-build target', () => {
        expect(blocked('pnpm nx run-many --target=di-graph-generate')).toBe(false);
        expect(blocked('pnpm nx run-many -t di-graph-generate --all')).toBe(false);
        expect(blocked('pnpm nx run architecture:generate')).toBe(false);
    });

    it('ignores everything that is not a build', () => {
        expect(blocked('git status')).toBe(false);
        expect(blocked('pnpm install')).toBe(false);
        expect(blocked('pnpm wp-review-upsert-pr')).toBe(false);
        expect(blocked('cat package.json')).toBe(false);
        expect(blocked('pnpm nx graph')).toBe(false);
        expect(blocked('pnpm nx reset')).toBe(false);
    });

    /**
     * REGRESSION, from a real block. A polling loop that builds NOTHING — it queries npm and GitHub —
     * was refused, because its jq filter is whitespace-free, so commandCode used to unquote it: the
     * guards then saw bare shell syntax and split `select(.title|test("x"))` into a segment reading
     * exactly `test`, which classified as the workspace-wide test script.
     *
     * Two independent fixes, either of which alone clears this, and both are wanted: a quoted span
     * carrying shell metacharacters stays quoted (BashContext.stripProse), and a bare `test` counts
     * only under a package-manager runner (a naked `test` is POSIX test(1)).
     */
    it('does not block a jq filter whose text merely contains test( — no build is in that command', () => {
        expect(blocked(`gh pr list --json title --jq '.[]|select(.title|test("x"))'`)).toBe(false);
        expect(blocked(
            'for i in $(seq 1 170); do V=$(npm view @webpieces/nx-webpieces-rules version 2>/dev/null | tail -1); '
            + `M=$(gh pr list --state merged --limit 6 --json title --jq '[.[]|select(.title|test("whole-repo-build-guard";"i"))]|length' 2>/dev/null); `
            + 'if [ "$V" != "0.4.613" ] && [ -n "$V" ] && [ "$M" != "0" ]; then echo "..."; break; fi; sleep 60; done',
        )).toBe(false);
    });

    // POSIX test(1) — the `[` builtin spelled out. Never a build, at any cwd.
    it('does not block a naked test invocation', () => {
        expect(blocked('test -f package.json')).toBe(false);
        expect(blocked('test')).toBe(false);
    });

    // Matching is on ctx.commandCode, which drops heredoc bodies and quoted prose — this repo's own
    // commit messages and docs are full of the command names this guard blocks.
    it('does not block a commit message that merely mentions the blocked commands', () => {
        expect(blocked("git commit -m 'stop agents running pnpm run build-all'")).toBe(false);
        expect(blocked("git commit -F - <<'EOF'\nblock pnpm run build-all and bare vitest run\nEOF")).toBe(false);
    });
});

describe('whole-repo-build-guard message', () => {
    // The template is what the pr-gate config holds; the RESOLVED command is what an agent can
    // paste anywhere. Handing over the raw `$(…)` is how advice starts failing in the wrong context.
    it('prints the configured command with $(git …) expanded, never the raw template', () => {
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
        expect(message).not.toContain('$(');
    });

    it('follows the configured build command rather than a hard-coded one', () => {
        const message = new WholeRepoBuildGuardRule('make ci-affected').check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('make ci-affected');
    });

    /**
     * ONE command string per block. The fix hint used to hard-code the affected command as a literal
     * while the message read it from config, so a repo that configured a different build got two
     * refusal texts that disagreed — the exact drift this guard's docstring says a duplicated command
     * string causes.
     */
    it('prints the SAME command in the fix hint as in the message', () => {
        const rule = new WholeRepoBuildGuardRule('make ci-affected');
        const message = rule.check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(rule.fixHint.mainMessage).toContain('make ci-affected');
        expect(rule.fixHint.mainMessage).not.toContain('nx affected --target=ci');
        expect(message).toContain('make ci-affected');
    });

    // Read before check() has ever run (the report renders hints for rules that did not fire): the
    // fallback is the configured TEMPLATE, never a second literal.
    it('falls back to the configured template in the hint before any command is judged', () => {
        expect(new WholeRepoBuildGuardRule('make ci-affected').fixHint.mainMessage).toContain('make ci-affected');
    });

    // Absent config ⇒ the shipped default, which is the same string the pr-gate falls back to.
    it('falls back to the default affected command when the project configures none', () => {
        const message = new WholeRepoBuildGuardRule('')
            .check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
    });

    /**
     * The refusal names `pnpm wp-build` — ONE thing to type — and shows what it resolves to beside it.
     * Handing over only the raw nx incantation is how repos ended up hand-composing verify chains that
     * drifted into building the world; handing over only the bin would hide which command actually ran.
     */
    it('names pnpm wp-build, with the command it resolves to alongside', () => {
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm wp-build');
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
        expect(guard().fixHint.mainMessage).toContain('pnpm wp-build');
    });

    it('stays short — a guard message is read mid-task, not studied', () => {
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message.split('\n').length).toBeLessThanOrEqual(8);
    });
});

/**
 * There is exactly ONE refusal now. It used to be two, chosen by `experimental.buildGateLogCapture`:
 * "build smaller" when the build streamed to the terminal, and "do not build, read the log" when it did
 * not. Capturing is no longer optional for the GATE, so the message says both things at once and no key
 * selects between them.
 *
 * The second half of that — WHERE the log claim is allowed to appear — is the subject here. A
 * `FullLog :` pointer comes only from the gate (`GateLogFile.pointer`, via `BuildGateLog` /
 * `StageOutputLog`). `nx run <project>:ci` and `vitest run <path>` write no such file, so the claim
 * belongs to the `wp-build` line and nowhere else: a cure naming an artifact the command does not
 * produce sends a reader to grep a path that does not exist, while this same message forbids the
 * re-run that is their only alternative.
 */
describe('whole-repo-build-guard names the log, and only for the command that writes one', () => {
    it('names the affected build AND the log to grep instead of a second build', () => {
        pinHomeConfig(true);
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
        expect(message).toContain('FullLog');
        expect(message).toContain('Never re-run a build');
    });

    /**
     * The FullLog sentence must sit above the "Narrower still:" line — i.e. attached to wp-build — and
     * must not be phrased as covering every route. Asserted positionally rather than by wording, so a
     * rewrite that keeps the claim honest stays green and one that re-widens it goes red.
     */
    it('scopes the FullLog claim to the wp-build line, never to the narrower commands', () => {
        pinHomeConfig(true);
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        const lines = message.split('\n');
        const buildLine = lines.findIndex((l: string): boolean => l.includes('pnpm wp-build'));
        const narrower = lines.findIndex((l: string): boolean => l.includes('Narrower still'));
        const fullLog = lines.findIndex((l: string): boolean => l.includes('FullLog'));
        expect(buildLine).toBeGreaterThanOrEqual(0);
        expect(narrower).toBeGreaterThan(buildLine);
        expect(fullLog).toBeGreaterThan(buildLine);
        expect(fullLog).toBeLessThan(narrower);
        // The over-claim this test exists to prevent, in the wording it had.
        expect(message).not.toContain('Whichever you run');
    });
});

/**
 * ══ THE GATE — and the case that protects every consumer of these packages ══════════════════════════
 *
 * This guard is EXPERIMENTAL, and every `experimental.*` flag ships OFF and stays OFF for two years. Its
 * ONE switch is `experimental.whole-repo-build-guard` in the OPTIONAL machine-local
 * ~/.webpieces/config.json, and essentially nobody has that file. For all of them the guard must be
 * INERT — no block, no message, no log line — for every command, INCLUDING the ones it would otherwise
 * refuse. The first release of this guard got that wrong in the other direction (it shipped ON by
 * default AND demanded a webpieces.config.json entry, so upgrading blocked every Bash call), which is
 * what these tests exist to prevent recurring.
 *
 * ON requires the explicit boolean `true`. Absent file, absent section, absent key and an explicit
 * `false` are ONE state, and it is OFF — indistinguishable from "this guard does not exist".
 */
describe('whole-repo-build-guard honours the machine-local opt-in', () => {
    it('allows a command it would otherwise refuse, on a machine that never opted in', () => {
        pinHomeConfig(false);
        for (const command of ['pnpm run build-all', 'pnpm nx run-many --target=build', 'pnpm exec vitest run']) {
            expect(guard().check(ctx(command))).toEqual([]);
        }
    });

    it('blocks the same command once a machine opts in', () => {
        pinHomeConfig(true);
        expect(guard().check(ctx('pnpm run build-all')).length).toBe(1);
    });

    /**
     * END-TO-END, through the REAL loader, against an EMPTY temp HOME — the state of essentially every
     * machine. Not a stubbed HomeConfig: this is the one test that proves the guard's default with the
     * loader's own absent-file path in the loop, so a default restated in the wrong place cannot hide
     * behind a spy that supplies the answer.
     *
     * `homeDir` is injected rather than mutated: the loader takes it as a parameter, and no test may
     * read — let alone write — the developer's real ~/.webpieces/config.json.
     */
    it('is OFF end-to-end for a machine with NO ~/.webpieces/config.json, through the real loader', () => {
        const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-guard-home-'));
        // webpieces-disable no-unmanaged-exceptions -- chokepoint: the temp HOME is removed either way
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // Drop the suite-wide opt-in spy FIRST: capturing `load` while it is still mocked would
            // capture the mock, and calling it back would recurse until the stack died.
            vi.restoreAllMocks();
            const realLoad = HomeConfigService.prototype.load;
            vi.spyOn(HomeConfigService.prototype, 'load')
                .mockImplementation(function (this: HomeConfigService): HomeConfig {
                    return realLoad.call(this, tmpHome);
                });
            expect(fs.existsSync(path.join(tmpHome, '.webpieces', 'config.json'))).toBe(false);
            for (const command of ['pnpm run build-all', 'pnpm nx affected --target=ci', 'pnpm exec vitest run']) {
                expect(guard().check(ctx(command)), command).toEqual([]);
            }
            // And the load itself never threw — the shape of the original outage was a config-LOAD
            // failure on machines that had no such file. Called through `realLoad` with the temp HOME
            // passed explicitly, so this asserts the loader and not the spy, and still never looks at
            // the developer's real HOME.
            expect(realLoad.call(new HomeConfigService(), tmpHome).wholeRepoBuildGuard).toBe(false);
        } finally {
            fs.rmSync(tmpHome, { recursive: true, force: true });
        }
    });

    /**
     * A file that EXISTS was deliberately created, so a wrong one is a HARD FAILURE naming the fix —
     * never a silent fallback. Editing ~/.webpieces/config.json is an unconditional PASS in the guards,
     * so this block is always self-curable.
     */
    it('blocks with the loader’s own fix instruction when the home config is present but wrong', () => {
        vi.spyOn(HomeConfigService.prototype, 'load').mockImplementation((): never => {
            throw new InformAiError('[~/.webpieces/config.json] "experimental.whole-repo-build-guard" must be the boolean true or false, not "yes".');
        });
        const violations = guard().check(ctx('git status'));
        expect(violations.length).toBe(1);
        const message = violations[0].message ?? '';
        expect(message).toContain('~/.webpieces/config.json is present but unusable');
        expect(message).toContain('"experimental.whole-repo-build-guard" must be the boolean');
    });

    it('reports a non-InformAiError failure too, rather than judging the command on a guess', () => {
        vi.spyOn(HomeConfigService.prototype, 'load').mockImplementation((): never => {
            throw new Error('EIO: i/o error');
        });
        const message = guard().check(ctx('git status'))[0].message ?? '';
        expect(message).toContain('could not be read');
    });
});
