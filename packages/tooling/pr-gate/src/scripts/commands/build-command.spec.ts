import { describe, it, expect, vi } from 'vitest';
import { RepoRootFinder } from '@webpieces/rules-config';

import { BuildCommand } from './build-command';
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
function harness(): Harness {
    const calls: BuildGateOptions[] = [];
    // webpieces-disable no-any-unknown -- a test double standing in for the injected collaborator
    const gate = {
        runBuildGate: (_root: string, opts: BuildGateOptions): void => { calls.push(opts); },
    } as unknown as BuildAffected;
    // webpieces-disable no-any-unknown -- ditto; only resolveRepoRoot is exercised
    const roots = { resolveRepoRoot: (): string => '/repo' } as unknown as RepoRootFinder;
    return new Harness(new BuildCommand(gate, roots), gate, calls);
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
    it('propagates a failing build rather than swallowing it', () => {
        const h = harness();
        vi.spyOn(h.gate, 'runBuildGate').mockImplementation((): never => { throw new Error('build failed'); });
        expect((): Promise<void> => h.command.run()).toThrow('build failed');
    });
});
