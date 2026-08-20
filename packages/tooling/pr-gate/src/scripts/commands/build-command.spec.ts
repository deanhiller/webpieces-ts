import { describe, it, expect, vi } from 'vitest';
import {
    BuildsLog, DEFAULT_MAX_CONCURRENT_BUILDS, HomeConfig, HomeConfigService, RepoRootFinder,
    RunningBuild, RuleFailError, toError,
} from '@webpieces/rules-config';

import { BuildCommand, BuildOptions, TOO_MANY_CONCURRENT_BUILDS } from './build-command';
import { BuildAffected, BuildGateOptions } from '../workflow/build-affected';
import { BUILD_STAGE, REVIEW_STAGE, FINISH_STAGE } from '../workflow/build-gate-log';

/** The command under test plus the doubles it was built from. Data-only, per the codebase convention. */
class Harness {
    command: BuildCommand;
    gate: BuildAffected;
    calls: BuildGateOptions[];

    constructor(command: BuildCommand, gate: BuildAffected, calls: BuildGateOptions[]) {
        this.command = command;
        this.gate = gate;
        this.calls = calls;
    }
}

/**
 * `wp-build` exists because the ONE correct build command lived in `commands.pr-gate.buildCommand` and
 * nothing surfaced it, so repos hand-composed verify chains that drifted into building the world. These
 * tests pin the two properties that stop it becoming another such chain: it goes through the SAME gate
 * the PR flow uses, and it adds nothing of its own.
 */
/** N live builds, as `BuildsLog.running()` would report them. */
function liveBuilds(count: number): RunningBuild[] {
    return Array.from({ length: count }, (_unused: unknown, i: number): RunningBuild =>
        new RunningBuild(`id-${String(i)}`, 'build', '/repo', 'primary', '/repo', 'dean/x', 999_000 + i,
            Date.now() - 30_000));
}

function harness(alreadyRunning = 0): Harness {
    const calls: BuildGateOptions[] = [];
    // webpieces-disable no-any-unknown -- a test double standing in for the injected collaborator
    const gate = {
        runBuildGate: (_root: string, opts: BuildGateOptions): Promise<void> => {
            calls.push(opts);
            return Promise.resolve();
        },
    } as unknown as BuildAffected;
    // webpieces-disable no-any-unknown -- ditto; only resolveRepoRoot is exercised
    const roots = { resolveRepoRoot: (): string => '/repo' } as unknown as RepoRootFinder;
    // The ledger and the preference file are both stubbed so the suite can never read — or write — the
    // developer's real `~/.webpieces`, and so the refusal threshold is a fact of the test rather than of
    // whatever else the machine happens to be building.
    // webpieces-disable no-any-unknown -- test doubles for the injected collaborators
    const buildsLog = { running: (): RunningBuild[] => liveBuilds(alreadyRunning) } as unknown as BuildsLog;
    // webpieces-disable no-any-unknown -- ditto
    const homeConfig = {
        load: (): HomeConfig => new HomeConfig(false, false, false, DEFAULT_MAX_CONCURRENT_BUILDS),
    } as unknown as HomeConfigService;
    return new Harness(new BuildCommand(gate, roots, buildsLog, homeConfig), gate, calls);
}

/** The refusal, caught and typed. Fails loudly if the build was allowed to start. */
function refusal(command: BuildCommand, opts: BuildOptions): RuleFailError {
    let caught: Error | null = null;
    // webpieces-disable no-unmanaged-exceptions -- chokepoint: the refusal IS the assertion subject
    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
    try {
        void command.run(opts);
    } catch (err: unknown) {
        const error = toError(err);
        caught = error;
    }
    if (caught === null) throw new Error('wp-build was expected to REFUSE and did not');
    expect(caught).toBeInstanceOf(RuleFailError);
    return caught as RuleFailError;
}

describe('wp-build runs the project build through the ONE shared gate', () => {
    /**
     * THE test. Composition is what drifted in the sibling repo's `ci:local`, so wp-build must delegate
     * to BuildAffected.runBuildGate — which resolves `commands.pr-gate.buildCommand`, announces it, runs
     * it, honours buildGateLogCapture and renders the failure — rather than doing any of that itself.
     * A second resolver or a second failure string is a second thing that can drift.
     */
    it('delegates to runBuildGate rather than resolving or spawning anything itself', async () => {
        const h = harness();
        await h.command.run();
        expect(h.calls.length).toBe(1);
    });

    it('tells the agent to re-run `pnpm wp-build`, the same verb it just ran', async () => {
        const h = harness();
        await h.command.run();
        expect(h.calls[0].rerunCommand).toBe('pnpm wp-build');
    });

    /**
     * The log stage id is part of the captured log's FILENAME. Sharing one with stage ② or ③ would let a
     * developer's inner-loop build silently overwrite the log the PR flow is holding for that commit.
     */
    it('captures under its own stage id, never the review or finish one', async () => {
        const h = harness();
        await h.command.run();
        expect(h.calls[0].stage).toBe(BUILD_STAGE);
        expect(h.calls[0].stage).not.toBe(REVIEW_STAGE);
        expect(h.calls[0].stage).not.toBe(FINISH_STAGE);
    });

    // runBuildGate throws CliExitError on a red build so runMain owns the exit; wp-build must not swallow
    // it and report success, which would make a green terminal meaningless.
    // runBuildGate throws synchronously, before run() ever builds its promise, so the throw surfaces at
    // the call rather than as a rejection — and runMain, which invokes this, handles both alike.
    /**
     * The whole console contract of wp-build is "a heartbeat, then a pointer at .webpieces/build.log", so
     * capture may not depend on the EXPERIMENTAL `~/.webpieces/config.json` opt-in that essentially no
     * machine has — a wp-build that did not capture would have nothing to point at.
     */
    it('captures unconditionally, not on the experimental opt-in', async () => {
        const h = harness();
        await h.command.run();
        expect(h.calls[0].alwaysCapture).toBe(true);
    });

    it('propagates a failing build rather than swallowing it', async () => {
        const h = harness();
        vi.spyOn(h.gate, 'runBuildGate').mockImplementation((): Promise<void> => Promise.reject(new Error('build failed')));
        await expect(h.command.run()).rejects.toThrow('build failed');
    });
});

/**
 * The back-pressure half. CPU contention between agents building at once was measured at ~3.2x total
 * test time, so the fourth simultaneous build helps nobody — but the REFUSAL is only ever aimed at the
 * ad-hoc `wp-build`. The gate stages have no equivalent check at all: refusing there wedges a PR that
 * has nowhere else to go, which is why the count lives in this command and not in `runBuildGate`.
 */
describe('wp-build refuses to pile onto a machine that is already at its build limit', () => {
    it('runs normally while the machine is under the limit', async () => {
        const h = harness(DEFAULT_MAX_CONCURRENT_BUILDS - 1);
        await h.command.run();
        expect(h.calls.length).toBe(1);
    });

    it('refuses at the limit, and does NOT start the build', () => {
        const h = harness(DEFAULT_MAX_CONCURRENT_BUILDS);
        expect(refusal(h.command, new BuildOptions()).ruleName).toBe(TOO_MANY_CONCURRENT_BUILDS);
        expect(h.calls.length).toBe(0);
    });

    /**
     * The cures are `Option`s, rendered by the framework's `formatFixOptions`. This asserts the TEXT of
     * each, and deliberately NOT a hand-numbered "1." / "2." in the message — numbering cures inside a
     * string literal is an automatic review reject, and this is the test that would go red if somebody
     * moved them back in there.
     */
    it('offers the gate flow first and `--force` LAST, as Options the framework numbers', () => {
        const error = refusal(harness(DEFAULT_MAX_CONCURRENT_BUILDS).command, new BuildOptions());
        expect(error.fixOptions.length).toBeGreaterThan(1);
        expect(error.fixOptions[0].preferred).toBe(true);
        expect(error.fixOptions[0].text).toContain('wp-review-upsert-pr');
        const last = error.fixOptions[error.fixOptions.length - 1].text;
        expect(last).toContain('really stuck');
        expect(last).toContain('really really need wp-build');
        expect(last).toContain('pnpm wp-build --force');
        // The cures live in fixOptions, never pre-numbered into the message itself.
        expect(error.aiMessage).not.toContain('Fix Option');
    });

    it('names the builds it found, so the reader can tell which tree to look at', () => {
        const error = refusal(harness(DEFAULT_MAX_CONCURRENT_BUILDS).command, new BuildOptions());
        expect(error.aiMessage).toContain('/repo');
        expect(error.aiMessage).toContain('dean/x');
    });

    /**
     * `--force` skips the COUNT CHECK and nothing else — the BuildGateOptions handed to the gate are
     * byte-for-byte the ones an unforced run passes, because `wp-build` runs `buildCommand` verbatim and
     * a flag that changed the command would stop it being the command the PR gate runs.
     */
    it('--force builds anyway, with the identical gate options', async () => {
        const forced = harness(DEFAULT_MAX_CONCURRENT_BUILDS * 3);
        await forced.command.run(new BuildOptions(true));
        const normal = harness();
        await normal.command.run();
        expect(forced.calls.length).toBe(1);
        expect(forced.calls[0]).toEqual(normal.calls[0]);
    });
});
