import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The guard shells out ONLY to expand `$(git …)` inside the configured build command. Pin it so the
// resolved-command assertions are about the guard's substitution, not this checkout's sha.
vi.mock('child_process', () => ({
    execSync: (): string => 'abc1234def\n',
}));

// The decision log writes to disk; silence it so these tests never touch the fs.
vi.mock('../decision-log', () => ({
    logGuardDecision: (): void => undefined,
    GuardDecision: class { constructor(...args: unknown[]) { void args; } },
}));

import { WholeRepoBuildGuardConfig, HomeConfigService } from '@webpieces/rules-config';
import { BashContext } from '../types';
import { WholeRepoBuildGuardRule } from './whole-repo-build-guard';

const GATE_COMMAND = 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)';

function ctx(command: string): BashContext {
    return new BashContext(command, '/repo');
}

// A command run somewhere OTHER than the workspace root — the one input that changes how a bare
// `pnpm test` is judged.
function ctxInSubdir(command: string): BashContext {
    return new BashContext(command, '/repo', '/repo/apps/site');
}

function guard(): WholeRepoBuildGuardRule {
    const config = new WholeRepoBuildGuardConfig();
    // load-config injects this from commands.pr-gate.buildCommand; the spec supplies it directly.
    config.affectedBuildCommand = GATE_COMMAND;
    return new WholeRepoBuildGuardRule(config);
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

    // Matching is on ctx.commandCode, which drops heredoc bodies and quoted prose — this repo's own
    // commit messages and docs are full of the command names this guard blocks.
    it('does not block a commit message that merely mentions the blocked commands', () => {
        expect(blocked("git commit -m 'stop agents running pnpm run build-all'")).toBe(false);
        expect(blocked("git commit -F - <<'EOF'\nblock pnpm run build-all and bare vitest run\nEOF")).toBe(false);
    });
});

describe('whole-repo-build-guard message', () => {
    // This block is about the DEFAULT refusal, so pin the OPTIONAL home config to its default. The
    // machine running the tests may well have opted into build-log capture, and a test that reads the
    // developer's own preferences is a test that passes or fails by accident.
    beforeEach(() => {
        vi.spyOn(HomeConfigService.prototype, 'load').mockReturnValue({ buildGateLogCapture: false });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    // The template is what webpieces.config.json holds; the RESOLVED command is what an agent can
    // paste anywhere. Handing over the raw `$(…)` is how advice starts failing in the wrong context.
    it('prints the configured command with $(git …) expanded, never the raw template', () => {
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
        expect(message).not.toContain('$(');
    });

    it('follows the configured build command rather than a hard-coded one', () => {
        const config = new WholeRepoBuildGuardConfig();
        config.affectedBuildCommand = 'make ci-affected';
        const message = new WholeRepoBuildGuardRule(config).check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('make ci-affected');
    });

    /**
     * ONE command string per block. The fix hint used to hard-code the affected command as a literal
     * while the message read it from config, so a repo that configured a different build got two
     * refusal texts that disagreed — the exact drift this guard's docstring says a duplicated command
     * string causes.
     */
    it('prints the SAME command in the fix hint as in the message', () => {
        const config = new WholeRepoBuildGuardConfig();
        config.affectedBuildCommand = 'make ci-affected';
        const rule = new WholeRepoBuildGuardRule(config);
        const message = rule.check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(rule.fixHint.mainMessage).toContain('make ci-affected');
        expect(rule.fixHint.mainMessage).not.toContain('nx affected --target=ci');
        expect(message).toContain('make ci-affected');
    });

    // Read before check() has ever run (the report renders hints for rules that did not fire): the
    // fallback is the configured TEMPLATE, never a second literal.
    it('falls back to the configured template in the hint before any command is judged', () => {
        const config = new WholeRepoBuildGuardConfig();
        config.affectedBuildCommand = 'make ci-affected';
        expect(new WholeRepoBuildGuardRule(config).fixHint.mainMessage).toContain('make ci-affected');
    });

    // Absent config ⇒ the shipped default, which is the same string the pr-gate falls back to.
    it('falls back to the default affected command when the project configures none', () => {
        const message = new WholeRepoBuildGuardRule(new WholeRepoBuildGuardConfig())
            .check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
    });

    it('stays short — a guard message is read mid-task, not studied', () => {
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message.split('\n').length).toBeLessThanOrEqual(6);
    });
});

/**
 * `~/.webpieces/config.json` → `experimental.buildGateLogCapture` picks WHICH refusal is printed. The
 * file is OPTIONAL and absent for essentially every consumer, so the default path must be the one
 * that names a build command; only an opted-in machine is told not to build at all.
 */
describe('whole-repo-build-guard picks its message from ~/.webpieces/config.json', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('with capture OFF (the default, and the absent-file state) names the affected build', () => {
        vi.spyOn(HomeConfigService.prototype, 'load').mockReturnValue({ buildGateLogCapture: false });
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected --target=ci --base=abc1234def');
        expect(message).not.toContain('wp-review-upsert-pr');
    });

    it('with capture ON says do not build — stage ② builds and writes a readable log', () => {
        vi.spyOn(HomeConfigService.prototype, 'load').mockReturnValue({ buildGateLogCapture: true });
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm wp-review-upsert-pr');
        expect(message).toContain('stage ②');
        expect(message).toContain('log file');
        // wp-start-upsert-pr runs NO build gate. Naming it here would tell an agent the build happens
        // a stage earlier than it does — see BuildAffected's callers.
        expect(message).not.toContain('wp-start-upsert-pr');
        expect(message.split('\n').length).toBeLessThanOrEqual(6);
    });

    // A broken/unreadable home config may never change how a Bash command is judged.
    it('falls back to the ordinary message when the home config throws', () => {
        vi.spyOn(HomeConfigService.prototype, 'load').mockImplementation((): never => {
            throw new Error('~/.webpieces/config.json is not valid JSON');
        });
        const message = guard().check(ctx('pnpm run build-all'))[0].message ?? '';
        expect(message).toContain('pnpm nx affected');
    });
});
