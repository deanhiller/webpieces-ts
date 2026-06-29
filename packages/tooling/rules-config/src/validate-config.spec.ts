import { validateWebpiecesConfig } from './validate-config';

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

    it('missing-rule snippet lists mode as required and escape hatches as optional', () => {
        // Omit no-file-import-cycles so the snippet is emitted for it.
        const errors = validateWebpiecesConfig({});
        const snippet = errors.find(e => e.includes('[no-file-import-cycles] Not configured'));
        expect(snippet).toBeDefined();
        // Required block contains mode...
        expect(snippet!).toContain('"mode"');
        // ...and the escape hatches appear under the optional section, not the required entry.
        const [requiredBlock, optionalBlock] = snippet!.split('Optional fields you may add');
        expect(optionalBlock).toBeDefined();
        expect(requiredBlock).not.toContain('ignoreRuleWhileOnBranch');
        expect(optionalBlock).toContain('ignoreRuleWhileOnBranch');
        expect(optionalBlock).toContain('ignoreModifiedUntilEpoch');
    });
});
