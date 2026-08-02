import { validateExcludePaths } from './validate-config';

describe('validateExcludePaths', () => {
    it('errors with a copy-paste example when the block is missing (required)', () => {
        const errors = validateExcludePaths(undefined);
        expect(errors.some(e => e.includes('[excludePaths] Not configured'))).toBe(true);
        expect(errors.some(e => e.includes('"excludePaths": ["repositories/**"]'))).toBe(true);
    });

    it('accepts the canonical single list, empty or populated', () => {
        expect(validateExcludePaths([])).toEqual([]);
        expect(validateExcludePaths(['repositories/**', 'vendor/**'])).toEqual([]);
    });

    // The retired two-list object is REJECTED, not unioned. It was accepted once, which is exactly why
    // consumer configs stayed on it — an accepted shape is never migrated. Rejecting it cannot wedge a
    // repo: editing webpieces.config.json is permitted even while the config is invalid.
    it('rejects the retired { rules, guards } object, naming the union it must become', () => {
        for (const legacy of [
            { rules: [], guards: [] },
            { rules: ['repositories/**'], guards: ['vendor/**'] },
            { rules: ['repositories/**'] },
            { guards: ['vendor/**'] },
        ]) {
            const errors = validateExcludePaths(legacy);
            expect(errors.some(e => e.includes('RETIRED'))).toBe(true);
            expect(errors.some(e => e.includes('ONE array holding the union'))).toBe(true);
            expect(errors.some(e => e.includes('"excludePaths": ["repositories/**"]'))).toBe(true);
        }
    });

    it('rejects a non-string entry in the canonical list', () => {
        expect(validateExcludePaths([1, 2]).some(e => e.includes('"excludePaths" must be a string[]'))).toBe(true);
    });

    it('rejects a scalar, and an object carrying neither retired key (a typo, not a legacy config)', () => {
        expect(validateExcludePaths('nope').some(e => e.includes('Must be a string[]'))).toBe(true);
        expect(validateExcludePaths({ rulez: [] }).some(e => e.includes('Must be a string[]'))).toBe(true);
    });
});
