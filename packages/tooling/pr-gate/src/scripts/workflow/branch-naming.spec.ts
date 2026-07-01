import { describe, it, expect } from 'vitest';
import { baseBranchName, nextBranchName, preMergeBackupName } from './branch-naming';

describe('baseBranchName', () => {
    it('leaves a gen-1 branch unchanged', () => {
        expect(baseBranchName('feat/x-migration')).toBe('feat/x-migration');
    });

    it('strips the generation number', () => {
        expect(baseBranchName('feat/x-migration2')).toBe('feat/x-migration');
        expect(baseBranchName('feat/x-migration3')).toBe('feat/x-migration');
    });

    it('strips a trailing Squash temp suffix', () => {
        expect(baseBranchName('feat/x-migrationSquash')).toBe('feat/x-migration');
        expect(baseBranchName('feat/x-migration2Squash')).toBe('feat/x-migration');
    });

    it('KNOWN LIMITATION: misreads a branch that naturally ends in digits', () => {
        // documents current behavior — trailing digits are always read as a generation
        expect(baseBranchName('feature/ONE-1917')).toBe('feature/ONE-');
    });
});

describe('nextBranchName', () => {
    it('bumps gen 1 to 2', () => {
        expect(nextBranchName('feat/x-migration')).toBe('feat/x-migration2');
    });

    it('bumps a numbered generation', () => {
        expect(nextBranchName('feat/x-migration2')).toBe('feat/x-migration3');
    });

    it('is stable through a Squash temp name', () => {
        expect(nextBranchName('feat/x-migrationSquash')).toBe('feat/x-migration2');
        expect(nextBranchName('feat/x-migration2Squash')).toBe('feat/x-migration3');
    });
});

describe('preMergeBackupName', () => {
    it('appends PreMerge to the current branch', () => {
        expect(preMergeBackupName('feat/x-migration')).toBe('feat/x-migrationPreMerge');
        expect(preMergeBackupName('feat/x-migration2')).toBe('feat/x-migration2PreMerge');
    });
});
