import { describe, it, expect } from 'vitest';
import { BranchNaming } from './branch-naming';

const bn = new BranchNaming();
const baseBranchName = (b: string): string => bn.baseBranchName(b);
const preMergeBackupName = (b: string, n: number): string => bn.preMergeBackupName(b, n);

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

describe('preMergeBackupName', () => {
    it('always numbers from 1 (no bare PreMerge)', () => {
        expect(preMergeBackupName('feat/x-migration', 1)).toBe('feat/x-migrationPreMerge1');
        expect(preMergeBackupName('feat/x-migration', 2)).toBe('feat/x-migrationPreMerge2');
        expect(preMergeBackupName('feat/x-migration', 3)).toBe('feat/x-migrationPreMerge3');
    });
});
