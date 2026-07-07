import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliExitError } from '@webpieces/rules-config';

// Mutable state the child_process mock reads. vi.hoisted so the factory can close over it.
const state = vi.hoisted(() => ({ branch: 'dean/x', openPrNumber: '' }));

// execSync → current branch; spawnSync → the `gh pr list … --state open` lookup (openPrForBranch).
vi.mock('child_process', () => ({
    execSync: (): string => `${state.branch}\n`,
    spawnSync: (): { status: number; stdout: string } => ({ status: 0, stdout: `${state.openPrNumber}\n` }),
}));

import { assertNoOpenPr } from './wp-update-start';

describe('wp-update-start assertNoOpenPr (Bug #4: fail-fast when an open PR exists)', () => {
    beforeEach(() => {
        state.branch = 'dean/x';
        state.openPrNumber = '';
    });

    it('does nothing when there is no open PR', () => {
        state.openPrNumber = '';
        expect(() => assertNoOpenPr('/repo')).not.toThrow();
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
