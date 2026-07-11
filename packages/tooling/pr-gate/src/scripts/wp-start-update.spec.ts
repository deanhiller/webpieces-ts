import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliExitError } from '@webpieces/rules-config';

// Mutable state the child_process mock reads. vi.hoisted so the factory can close over it. `ghStatus`
// simulates gh's exit code (0 = answered; non-zero = couldn't reach GitHub → must fail fast).
const state = vi.hoisted(() => ({ branch: 'dean/x', openPrNumber: '', ghStatus: 0, ghStderr: '' }));

// execSync → current branch; spawnSync → the `gh pr list … --state open` lookup (openPrForBranch).
vi.mock('child_process', () => ({
    execSync: (): string => `${state.branch}\n`,
    spawnSync: (): { status: number; stdout: string; stderr: string } =>
        ({ status: state.ghStatus, stdout: `${state.openPrNumber}\n`, stderr: state.ghStderr }),
}));

import { StartUpdateCommand } from './commands/start-update-command';
import { OpenPrCheck } from './workflow/open-pr-check';
import { BranchNaming } from './workflow/branch-naming';
import type { RunUpdate } from './workflow/run-update';

const cmd = new StartUpdateCommand(new OpenPrCheck(new BranchNaming()), {} as RunUpdate);
const assertNoOpenPr = (repoRoot: string): void => cmd.assertNoOpenPr(repoRoot);

describe('wp-start-update assertNoOpenPr (Bug #4: fail-fast when an open PR exists)', () => {
    beforeEach(() => {
        state.branch = 'dean/x';
        state.openPrNumber = '';
        state.ghStatus = 0;
        state.ghStderr = '';
    });

    it('does nothing when there is no open PR', () => {
        state.openPrNumber = '';
        expect(() => assertNoOpenPr('/repo')).not.toThrow();
    });

    it('FAILS FAST when gh cannot reach GitHub (never assumes "no PR")', () => {
        // gh exits non-zero (offline / not authenticated). We must NOT treat that as "no open PR" and
        // proceed — that is exactly how a PR gets stranded on the old branch generation.
        state.ghStatus = 1;
        state.ghStderr = 'gh: not authenticated';
        state.openPrNumber = '';
        expect(() => assertNoOpenPr('/repo')).toThrow(CliExitError);
        expect(() => assertNoOpenPr('/repo')).toThrow(/Could not ask GitHub/);
    });

    it('throws a CliExitError steering to the PR flow when an open PR exists', () => {
        state.openPrNumber = '42';
        expect(() => assertNoOpenPr('/repo')).toThrow(CliExitError);
        // The message names the offending PR and both PR-flow commands.
        expect(() => assertNoOpenPr('/repo')).toThrow(/#42/);
        expect(() => assertNoOpenPr('/repo')).toThrow(/wp-start-upsert-pr/);
        expect(() => assertNoOpenPr('/repo')).toThrow(/wp-finish-upsert-pr/);
    });

    it('resolves the open PR by the STABLE base name for a numbered generation branch', () => {
        // On dean/xwp3 the PR still lives on the base `dean/x`; the guard must still fire.
        state.branch = 'dean/xwp3';
        state.openPrNumber = '7';
        expect(() => assertNoOpenPr('/repo')).toThrow(CliExitError);
    });
});
