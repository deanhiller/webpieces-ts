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

    // BACK-COMPAT: an unmigrated config must keep validating. The block is REQUIRED, so rejecting the
    // legacy shape would block every Bash/Edit — including the edit that would migrate it.
    it('still accepts the legacy { rules, guards } object', () => {
        expect(validateExcludePaths({ rules: [], guards: [] })).toEqual([]);
        expect(validateExcludePaths({ rules: ['repositories/**'], guards: ['vendor/**'] })).toEqual([]);
        expect(validateExcludePaths({ rules: ['repositories/**'] })).toEqual([]);
    });

    it('rejects a non-string entry in the canonical list', () => {
        expect(validateExcludePaths([1, 2]).some(e => e.includes('"excludePaths" must be a string[]'))).toBe(true);
    });

    it('rejects a scalar, and an object carrying neither legacy key (a typo, not a legacy config)', () => {
        expect(validateExcludePaths('nope').some(e => e.includes('Must be a string[]'))).toBe(true);
        expect(validateExcludePaths({ rulez: [] }).some(e => e.includes('Must be a string[]'))).toBe(true);
    });

    it('rejects a malformed list inside the legacy object', () => {
        expect(validateExcludePaths({ rules: [], guards: 'nope' }).some(e => e.includes('"guards" must be a string[]'))).toBe(true);
        expect(validateExcludePaths({ rules: [1, 2], guards: [] }).some(e => e.includes('"rules" must be a string[]'))).toBe(true);
    });
});
