import { policyFixture } from '@webpieces/tooling-testkit';
import { RulePackRegistry } from '@webpieces/rules-config';
const fixtureRuleRegistry = new RulePackRegistry(policyFixture.manifests());
import { seedEntryForRule, validateWebpiecesConfig } from './validate-config';

function branchStateErrors(errors: string[]): string[] {
    return errors.filter(error => error.includes('[branch-state-guard]'));
}

describe('validateWebpiecesConfig — maxCommitsBehind must be explicit', () => {
    it('requires branch-state-guard.maxCommitsBehind', () => {
        const errors = validateWebpiecesConfig({
            'branch-state-guard': {
                mode: 'ON', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null,
            },
        }, fixtureRuleRegistry);
        expect(branchStateErrors(errors).some(
            error => error.includes('Missing required field "maxCommitsBehind"'))).toBe(true);
    });

    it('seeds maxCommitsBehind to five', () => {
        expect(seedEntryForRule('branch-state-guard', fixtureRuleRegistry)).toMatchObject({ maxCommitsBehind: 5 });
    });

    it('rejects negative and fractional thresholds', () => {
        for (const maxCommitsBehind of [-1, 1.5]) {
            const errors = validateWebpiecesConfig({
                'branch-state-guard': {
                    mode: 'ON', maxCommitsBehind,
                    turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null,
                },
            }, fixtureRuleRegistry);
            expect(branchStateErrors(errors).some(
                error => error.includes('must be a non-negative integer'))).toBe(true);
        }
    });
});

describe('validateWebpiecesConfig — featureBranchMaxCommitsBehind must be explicit (#1431)', () => {
    it('requires branch-state-guard.featureBranchMaxCommitsBehind, with no code default', () => {
        const errors = validateWebpiecesConfig({
            'branch-state-guard': {
                mode: 'ON', maxCommitsBehind: 5, turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null,
            },
        }, fixtureRuleRegistry);
        expect(branchStateErrors(errors).some(
            error => error.includes('Missing required field "featureBranchMaxCommitsBehind"'))).toBe(true);
    });

    it('seeds featureBranchMaxCommitsBehind to twenty', () => {
        expect(seedEntryForRule('branch-state-guard', fixtureRuleRegistry)).toMatchObject({ featureBranchMaxCommitsBehind: 20 });
    });

    it('rejects negative and fractional thresholds', () => {
        for (const featureBranchMaxCommitsBehind of [-1, 2.5]) {
            const errors = validateWebpiecesConfig({
                'branch-state-guard': {
                    mode: 'ON', maxCommitsBehind: 5, featureBranchMaxCommitsBehind,
                    turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null,
                },
            }, fixtureRuleRegistry);
            expect(branchStateErrors(errors)).toContain('[branch-state-guard] "featureBranchMaxCommitsBehind" must be a non-negative integer.');
        }
    });
});
