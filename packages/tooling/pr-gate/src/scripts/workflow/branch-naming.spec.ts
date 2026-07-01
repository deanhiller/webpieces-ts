import { describe, it, expect } from 'vitest';
import { baseBranchName, nextBranchName, preMergeBackupName } from './branch-naming';

describe('baseBranchName', () => {
    it('leaves a gen-1 branch unchanged', () => {
        expect(baseBranchName('feat/x-migration')).toBe('feat/x-migration');
    });

    it('strips the wp generation marker', () => {
        expect(baseBranchName('feat/x-migrationwp2')).toBe('feat/x-migration');
        expect(baseBranchName('feat/x-migrationwp3')).toBe('feat/x-migration');
    });

    it('strips a trailing Squash temp suffix', () => {
        expect(baseBranchName('feat/x-migrationSquash')).toBe('feat/x-migration');
        expect(baseBranchName('feat/x-migrationwp2Squash')).toBe('feat/x-migration');
    });

    it('does NOT mangle a branch that naturally ends in digits (version upgrades)', () => {
        // the whole reason for the wp marker: a bare-digit scheme stripped the 213
        expect(baseBranchName('deanhiller/upgrade-webpieces-0.3.213')).toBe('deanhiller/upgrade-webpieces-0.3.213');
        expect(baseBranchName('feature/ONE-1917')).toBe('feature/ONE-1917');
    });
});

describe('nextBranchName', () => {
    it('bumps gen 1 to wp2', () => {
        expect(nextBranchName('feat/x-migration')).toBe('feat/x-migrationwp2');
    });

    it('bumps a numbered generation', () => {
        expect(nextBranchName('feat/x-migrationwp2')).toBe('feat/x-migrationwp3');
    });

    it('is stable through a Squash temp name', () => {
        expect(nextBranchName('feat/x-migrationSquash')).toBe('feat/x-migrationwp2');
        expect(nextBranchName('feat/x-migrationwp2Squash')).toBe('feat/x-migrationwp3');
    });

    it('gives a version-upgrade branch a clean wp2 (no digit mangling)', () => {
        expect(nextBranchName('deanhiller/upgrade-webpieces-0.3.213')).toBe('deanhiller/upgrade-webpieces-0.3.213wp2');
    });
});

describe('preMergeBackupName', () => {
    it('appends PreMerge to the current branch', () => {
        expect(preMergeBackupName('feat/x-migration')).toBe('feat/x-migrationPreMerge');
        expect(preMergeBackupName('feat/x-migrationwp2')).toBe('feat/x-migrationwp2PreMerge');
    });
});
