import { validateWebpiecesConfig, validatePrGateSection, validateSectionPlacement, validateCommandsSection } from './validate-config';

// Helper: errors mentioning a given rule name.
function errorsFor(rule: string, errors: string[]): string[] {
    return errors.filter(e => e.includes(`[${rule}]`));
}

describe('validateWebpiecesConfig', () => {
    it('accepts excludePackages + escape hatches on no-file-import-cycles (regression)', () => {
        const errors = validateWebpiecesConfig({
            'no-file-import-cycles': {
                mode: 'ON',
                ignoreTypeOnly: false,
                excludePackages: ['@kami/entities'],
                ignoreModifiedUntilEpoch: 1771931925,
                ignoreRuleWhileOnBranch: 'deanhiller/foo',
            },
        });
        // No field-level complaints for this rule (missing-OTHER-rule errors are expected and ignored).
        const fieldErrors = errorsFor('no-file-import-cycles', errors).filter(e => e.includes('Unknown field') || e.includes('must be'));
        expect(fieldErrors).toEqual([]);
    });

    it('still rejects a genuinely unknown field', () => {
        const errors = validateWebpiecesConfig({
            'no-file-import-cycles': { mode: 'ON', bogusField: true },
        });
        expect(errorsFor('no-file-import-cycles', errors).some(e => e.includes('Unknown field "bogusField"'))).toBe(true);
    });

    it('every rule accepts the universal escape hatches', () => {
        const errors = validateWebpiecesConfig({
            'no-shell-substitution': { mode: 'ON', ignoreRuleWhileOnBranch: 'x', ignoreModifiedUntilEpoch: 1 },
            'pr-merge-cleanup': { mode: 'ON', ignoreRuleWhileOnBranch: 'x', ignoreModifiedUntilEpoch: 1 },
            'no-edit-on-main': { mode: 'ON', ignoreRuleWhileOnBranch: 'x', ignoreModifiedUntilEpoch: 1 },
        });
        for (const rule of ['no-shell-substitution', 'pr-merge-cleanup', 'no-edit-on-main']) {
            const fieldErrors = errorsFor(rule, errors).filter(e => e.includes('Unknown field'));
            expect(fieldErrors).toEqual([]);
        }
    });

    it('missing-rule snippet lists mode + ignoreModifiedUntilEpoch as required, ignoreRuleWhileOnBranch as optional', () => {
        // Omit no-file-import-cycles so the snippet is emitted for it.
        const errors = validateWebpiecesConfig({});
        const snippet = errors.find(e => e.includes('[no-file-import-cycles] Not configured'));
        expect(snippet).toBeDefined();
        // Required block contains mode...
        expect(snippet!).toContain('"mode"');
        const [requiredBlock, optionalBlock] = snippet!.split('Optional fields you may add');
        expect(optionalBlock).toBeDefined();
        // ignoreModifiedUntilEpoch is now REQUIRED — it appears in the required copy-paste entry.
        expect(requiredBlock).toContain('ignoreModifiedUntilEpoch');
        expect(optionalBlock).not.toContain('ignoreModifiedUntilEpoch');
        // ignoreRuleWhileOnBranch stays optional.
        expect(requiredBlock).not.toContain('ignoreRuleWhileOnBranch');
        expect(optionalBlock).toContain('ignoreRuleWhileOnBranch');
    });
});

describe('validateWebpiecesConfig — required fields + branch-creation-guard modes', () => {
    it('rejects a present rule that is missing the required ignoreModifiedUntilEpoch', () => {
        const errors = validateWebpiecesConfig({
            'no-shell-substitution': { mode: 'ON' },
        });
        expect(
            errorsFor('no-shell-substitution', errors).some(
                e => e.includes('Missing required field "ignoreModifiedUntilEpoch"'),
            ),
        ).toBe(true);
    });

    it('rejects a present rule that is missing the required mode', () => {
        const errors = validateWebpiecesConfig({
            'no-shell-substitution': { ignoreModifiedUntilEpoch: 0 },
        });
        expect(
            errorsFor('no-shell-substitution', errors).some(
                e => e.includes('Missing required field "mode"'),
            ),
        ).toBe(true);
    });

    it('accepts a fully-specified rule (mode + ignoreModifiedUntilEpoch)', () => {
        const errors = validateWebpiecesConfig({
            'no-shell-substitution': { mode: 'OFF', ignoreModifiedUntilEpoch: 0 },
        });
        expect(errorsFor('no-shell-substitution', errors)).toEqual([]);
    });

    it('branch-creation-guard accepts ON_NO_SUBBRANCHES mode and branchFormat', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': {
                mode: 'ON_NO_SUBBRANCHES',
                branchFormat: 'Name it {whoami}/<feature>',
                subBranchNaming: 'feature/<ticket>/<desc>',
                ignoreModifiedUntilEpoch: 0,
            },
        });
        expect(errorsFor('branch-creation-guard', errors)).toEqual([]);
    });

    it('branch-creation-guard rejects an invalid mode', () => {
        const errors = validateWebpiecesConfig({
            'branch-creation-guard': { mode: 'SOMETIMES', ignoreModifiedUntilEpoch: 0 },
        });
        expect(
            errorsFor('branch-creation-guard', errors).some(
                e => e.includes('"mode" = "SOMETIMES" is not valid'),
            ),
        ).toBe(true);
    });
});

describe('validatePrGateSection', () => {
    it('errors with a copy-paste example when the block is missing', () => {
        const errors = validatePrGateSection(undefined);
        expect(errors.some(e => e.includes('[pr-gate] Not configured'))).toBe(true);
        expect(errors.some(e => e.includes('"buildCommand"'))).toBe(true);
    });

    it('requires buildCommand when mode is ON', () => {
        const errors = validatePrGateSection({ mode: 'ON' });
        expect(errors.some(e => e.includes('Missing required field "buildCommand"'))).toBe(true);
    });

    it('does not require buildCommand when mode is OFF', () => {
        expect(validatePrGateSection({ mode: 'OFF' })).toEqual([]);
    });

    it('accepts a full valid block (warningColor + disabled example gate)', () => {
        const errors = validatePrGateSection({
            mode: 'ON',
            buildCommand: 'pnpm nx affected --target=ci --base=$(git merge-base origin/main HEAD)',
            gates: [
                { name: 'API', patterns: ['**/*Api.ts'], warningColor: 'yellow' },
                { name: 'DB Schema', patterns: ['**/schema.prisma'], warningColor: 'red', disabled: true },
            ],
        });
        expect(errors).toEqual([]);
    });

    it('rejects a gate missing the required warningColor', () => {
        const bad = validatePrGateSection({
            mode: 'ON', buildCommand: 'x',
            gates: [{ name: 'API', patterns: ['**/*Api.ts'] }],
        });
        expect(bad.some(e => e.includes('gates[0].warningColor is required'))).toBe(true);
    });

    it('rejects an invalid mode and malformed gates', () => {
        const bad = validatePrGateSection({ mode: 'MAYBE', buildCommand: 'x', gates: [{ patterns: 'nope' }] });
        expect(bad.some(e => e.includes('"mode" = "MAYBE" is not valid'))).toBe(true);
        expect(bad.some(e => e.includes('gates[0].name must be a string'))).toBe(true);
        expect(bad.some(e => e.includes('gates[0].patterns must be string[]'))).toBe(true);
    });

    it('rejects an invalid gate warningColor and a non-boolean disabled', () => {
        const bad = validatePrGateSection({
            mode: 'ON', buildCommand: 'x',
            gates: [{ name: 'X', patterns: ['**/*.ts'], warningColor: 'warn', disabled: 'nope' }],
        });
        expect(bad.some(e => e.includes('gates[0].warningColor must be "yellow" or "red"'))).toBe(true);
        expect(bad.some(e => e.includes('gates[0].disabled must be a boolean'))).toBe(true);
    });
});

describe('validateSectionPlacement', () => {
    it('flags a guard left in the rules section', () => {
        const errors = validateSectionPlacement({ 'pr-creation-guard': { mode: 'ON' } }, {});
        expect(errors.some(e => e.includes('[pr-creation-guard]') && e.includes('"hookGuards"'))).toBe(true);
    });

    it('flags a code rule placed in the hookGuards section', () => {
        const errors = validateSectionPlacement({}, { 'no-any-unknown': { mode: 'MODIFIED_CODE' } });
        expect(errors.some(e => e.includes('[no-any-unknown]') && e.includes('"rules"'))).toBe(true);
    });

    it('accepts correctly-placed entries', () => {
        const errors = validateSectionPlacement(
            { 'no-any-unknown': { mode: 'MODIFIED_CODE' } },
            { 'pr-creation-guard': { mode: 'ON' } },
        );
        expect(errors).toEqual([]);
    });

    it('ignores unknown/custom names in hookGuards', () => {
        const errors = validateSectionPlacement({}, { 'my-custom-guard': { mode: 'ON' } });
        expect(errors).toEqual([]);
    });
});

describe('validateCommandsSection', () => {
    it('errors on a deprecated top-level pr-gate block', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' } }, { mode: 'OFF' });
        expect(errors.some(e => e.includes('top-level "pr-gate" block is deprecated'))).toBe(true);
    });

    it('validates commands.pr-gate (missing → error)', () => {
        const errors = validateCommandsSection({}, undefined);
        expect(errors.some(e => e.includes('[pr-gate] Not configured'))).toBe(true);
    });

    it('accepts a valid commands section with string command overrides', () => {
        const errors = validateCommandsSection(
            { 'pr-gate': { mode: 'OFF' }, upsertPr: 'pnpm wp-upsert-pr', mergeComplete: 'pnpm wp-git-merge-complete' },
            undefined,
        );
        expect(errors).toEqual([]);
    });

    it('rejects a non-string command field', () => {
        const errors = validateCommandsSection({ 'pr-gate': { mode: 'OFF' }, upsertPr: 123 }, undefined);
        expect(errors.some(e => e.includes('[commands] "upsertPr" must be a string'))).toBe(true);
    });
});
