import { validateWebpiecesConfig, seedEntryForRule } from './validate-config';

/**
 * `required-type-suffix` (#1037) — the config validator: `mode` and `entries` are required, `entries` is
 * non-empty, and every entry carries non-empty `paths` and `suffixes`. Each error names the exact spot.
 */

// webpieces-disable no-any-unknown -- a config entry is opaque JSON by construction
function errorsFor(entry: Record<string, unknown>): string[] {
    return validateWebpiecesConfig({ 'required-type-suffix': entry })
        .filter((e: string) => e.includes('[required-type-suffix]'));
}

// webpieces-disable no-any-unknown -- a config entry is opaque JSON by construction
function withEntries(entries: unknown): Record<string, unknown> {
    return { mode: 'NEW_AND_MODIFIED_CODE', entries, turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };
}

describe('required-type-suffix — config validation', () => {
    it('accepts the issue\'s two entries', () => {
        expect(errorsFor(withEntries([
            { paths: ['libraries/apis/internal/**'], suffixes: ['Request', 'Response', 'Event', 'Dto', 'Api'] },
            { paths: ['libraries/browser-node/fs-*-model/**'], suffixes: ['Fs'] },
        ]))).toEqual([]);
    });

    it('demands `entries`, and prints the element shape to paste', () => {
        const errors = errorsFor({ mode: 'OFF', turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null });
        expect(errors).toEqual([expect.stringContaining('Missing required field "entries"')]);
        expect(errors[0]).toContain('"paths": ["<string>", ...]');
        expect(errors[0]).toContain('"suffixes": ["<string>", ...]');
    });

    it('refuses an EMPTY `entries`', () => {
        expect(errorsFor(withEntries([]))).toEqual([expect.stringContaining('"entries" must not be empty')]);
    });

    it('refuses an entry with empty or missing `paths` / `suffixes`, naming the entry', () => {
        expect(errorsFor(withEntries([{ paths: [], suffixes: ['Dto'] }])))
            .toEqual([expect.stringContaining('"entries"[0].paths must not be empty')]);
        expect(errorsFor(withEntries([{ paths: ['a/**'], suffixes: ['Dto'] }, { paths: ['b/**'], suffixes: [] }])))
            .toEqual([expect.stringContaining('"entries"[1].suffixes must not be empty')]);
        expect(errorsFor(withEntries([{ paths: ['a/**'] }])))
            .toEqual([expect.stringContaining('"entries"[0] Missing required field "suffixes"')]);
    });

    it('refuses a wrong shape: a non-list, a non-object element, a non-string suffix, an unknown entry field', () => {
        expect(errorsFor(withEntries({ paths: ['a/**'] }))).toEqual([expect.stringContaining('must be a list of objects')]);
        expect(errorsFor(withEntries(['a/**']))).toEqual([expect.stringContaining('must be a list of objects')]);
        expect(errorsFor(withEntries([{ paths: ['a/**'], suffixes: [1] }])))
            .toEqual([expect.stringContaining('"entries"[0].suffixes must be string[]')]);
        expect(errorsFor(withEntries([{ paths: ['a/**'], suffixes: ['Dto'], suffix: 'Dto' }])))
            .toEqual([expect.stringContaining('"entries"[0] Unknown field "suffix"')]);
    });

    it('seeds an entry the validator accepts', () => {
        expect(errorsFor(seedEntryForRule('required-type-suffix'))).toEqual([]);
    });
});
