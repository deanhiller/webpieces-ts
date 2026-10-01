import { describe, it, expect } from 'vitest';
import { validateWebpiecesConfig, seedEntryForRule } from './validate-config';

/**
 * The five tag-truth rules (#1064) — the config validator: each required field is demanded, a
 * non-empty list refuses `[]`, every list element is checked against its own schema, and a config that
 * names none of them FAILS THE LOAD naming each one (no default lets an unconfigured rule run).
 */

const HATCHES = { turnOffRuleUntilEpoch: 0, turnOffRuleWhileOnBranch: null };

// webpieces-disable no-any-unknown -- a config entry is opaque JSON by construction
function errorsFor(rule: string, entry: Record<string, unknown>): string[] {
    return validateWebpiecesConfig({ [rule]: entry }).filter((e: string) => e.includes(`[${rule}]`));
}

describe('api-lib-dependencies — config validation', () => {
    it('accepts the reference consumer\'s entry, with an api-client', () => {
        expect(errorsFor('api-lib-dependencies', {
            mode: 'RUN_EVERY_TIME',
            apiLibPackages: ['@webpieces/core-util', 'tslib'],
            apiClients: [{ project: 'gmail', packages: ['googleapis', 'inversify', '@webpieces/core-context'] }],
            ...HATCHES,
        })).toEqual([]);
    });

    it('accepts an EMPTY apiClients and apiLibPackages — a repo with no api-client, and api libs importing nothing outside', () => {
        expect(errorsFor('api-lib-dependencies', { mode: 'OFF', apiLibPackages: [], apiClients: [], ...HATCHES })).toEqual([]);
    });

    it('demands apiLibPackages and apiClients', () => {
        const errors = errorsFor('api-lib-dependencies', { mode: 'OFF', ...HATCHES });
        expect(errors).toEqual([
            expect.stringContaining('Missing required field "apiLibPackages"'),
            expect.stringContaining('Missing required field "apiClients"'),
        ]);
    });

    it('checks every apiClients element against its schema', () => {
        expect(errorsFor('api-lib-dependencies', {
            mode: 'OFF', apiLibPackages: [], apiClients: [{ project: 'gmail' }], ...HATCHES,
        })).toEqual([expect.stringContaining('"apiClients"[0] Missing required field "packages"')]);
        expect(errorsFor('api-lib-dependencies', {
            mode: 'OFF', apiLibPackages: [], apiClients: [{ project: 7, packages: [] }], ...HATCHES,
        })).toEqual([expect.stringContaining('"apiClients"[0].project must be string')]);
    });

    it('refuses a mode a graph rule cannot honour', () => {
        expect(errorsFor('api-lib-dependencies', {
            mode: 'MODIFIED_PROJECTS', apiLibPackages: [], apiClients: [], ...HATCHES,
        })).toEqual([expect.stringContaining('"mode"')]);
    });
});

describe('api-lib-path — config validation', () => {
    it('accepts a glob list', () => {
        expect(errorsFor('api-lib-path', { mode: 'RUN_EVERY_TIME', paths: ['libraries/apis/**'], ...HATCHES })).toEqual([]);
    });

    it('demands a NON-EMPTY paths', () => {
        expect(errorsFor('api-lib-path', { mode: 'OFF', ...HATCHES }))
            .toEqual([expect.stringContaining('Missing required field "paths"')]);
        expect(errorsFor('api-lib-path', { mode: 'OFF', paths: [], ...HATCHES }))
            .toEqual([expect.stringContaining('"paths" must not be empty')]);
    });
});

describe('framework-folder — config validation', () => {
    const entry = { paths: ['libraries/node/**'], frameworkSets: ['node', 'express'], roles: ['lib', 'designed-lib'] };

    it('accepts an entry', () => {
        expect(errorsFor('framework-folder', { mode: 'RUN_EVERY_TIME', entries: [entry], ...HATCHES })).toEqual([]);
    });

    it('demands a non-empty entries, and non-empty paths / frameworkSets / roles in each', () => {
        expect(errorsFor('framework-folder', { mode: 'OFF', entries: [], ...HATCHES }))
            .toEqual([expect.stringContaining('"entries" must not be empty')]);
        expect(errorsFor('framework-folder', { mode: 'OFF', entries: [{ ...entry, frameworkSets: [] }], ...HATCHES }))
            .toEqual([expect.stringContaining('"entries"[0].frameworkSets must not be empty')]);
        expect(errorsFor('framework-folder', { mode: 'OFF', entries: [{ paths: ['a/**'], frameworkSets: ['node'] }], ...HATCHES }))
            .toEqual([expect.stringContaining('"entries"[0] Missing required field "roles"')]);
    });
});

describe('framework-tsconfig — config validation', () => {
    it('accepts the three modes, and an optional allowedPaths', () => {
        for (const mode of ['OFF', 'MODIFIED_PROJECTS', 'RUN_EVERY_TIME']) {
            expect(errorsFor('framework-tsconfig', { mode, ...HATCHES })).toEqual([]);
        }
        expect(errorsFor('framework-tsconfig', { mode: 'OFF', allowedPaths: ['legacy/**'], ...HATCHES })).toEqual([]);
    });

    it('demands mode', () => {
        expect(errorsFor('framework-tsconfig', { ...HATCHES })).toEqual([expect.stringContaining('"mode"')]);
    });
});

describe('framework-packages — config validation', () => {
    it('accepts an entry', () => {
        expect(errorsFor('framework-packages', {
            mode: 'MODIFIED_PROJECTS', entries: [{ packages: ['@angular/*'], frameworks: ['angular'] }], ...HATCHES,
        })).toEqual([]);
    });

    it('demands non-empty entries, packages and frameworks', () => {
        expect(errorsFor('framework-packages', { mode: 'OFF', ...HATCHES }))
            .toEqual([expect.stringContaining('Missing required field "entries"')]);
        expect(errorsFor('framework-packages', { mode: 'OFF', entries: [{ packages: [], frameworks: ['node'] }], ...HATCHES }))
            .toEqual([expect.stringContaining('"entries"[0].packages must not be empty')]);
    });
});

describe('the tag-truth rules have no default', () => {
    it('a config naming none of them fails the load, naming each one', () => {
        const errors = validateWebpiecesConfig({});
        for (const rule of ['api-lib-dependencies', 'api-lib-path', 'framework-folder', 'framework-tsconfig', 'framework-packages']) {
            expect(errors.some((e: string) => e.includes(rule)), rule).toBe(true);
        }
    });

    it('every seeded entry validates clean', () => {
        for (const rule of ['api-lib-dependencies', 'api-lib-path', 'framework-folder', 'framework-tsconfig', 'framework-packages']) {
            expect(errorsFor(rule, seedEntryForRule(rule)), rule).toEqual([]);
        }
    });
});
