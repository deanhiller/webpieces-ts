import { MinimatchInterop, MinimatchFn, minimatch } from './MinimatchInterop';
import { FilterMatcher } from './FilterMatcher';
import { FilterDefinition } from './WebAppMeta';

/**
 * Issue #747: under pnpm's `node-linker=hoisted` this package can resolve minimatch v3, whose
 * module IS the matcher function and has NO `.minimatch` property. The whole point of the interop
 * is that such a module still yields a working matcher.
 */
const v3StyleModule = ((path: string, pattern: string): boolean =>
    path === pattern || pattern === '**/*') as MinimatchFn & { minimatch?: MinimatchFn };

describe('MinimatchInterop.resolve', () => {
    const interop = new MinimatchInterop();

    it('returns the module ITSELF when it is a bare callable with no .minimatch (v3/v4 shape)', () => {
        expect('minimatch' in v3StyleModule).toBe(false);

        const resolved = interop.resolve(v3StyleModule);

        expect(resolved).toBe(v3StyleModule);
        expect(resolved('a/b.ts', 'a/b.ts')).toBe(true);
        expect(resolved('a/b.ts', 'nope')).toBe(false);
    });

    it('prefers the named export when the module carries one (v5+ shape)', () => {
        const named = ((): boolean => true) as unknown as MinimatchFn;
        const v10StyleModule = Object.assign(
            ((): boolean => {
                throw new Error('the module callable must not be used when a named export exists');
            }) as unknown as MinimatchFn,
            { minimatch: named },
        );

        expect(interop.resolve(v10StyleModule)).toBe(named);
    });

    it('resolves the REAL installed minimatch to a callable matcher', () => {
        expect(typeof minimatch).toBe('function');
        expect(minimatch('src/controllers/admin/x.ts', 'src/controllers/admin/**/*.ts')).toBe(true);
    });
});

describe('FilterMatcher uses the interop-resolved matcher', () => {
    it('still matches a controller filepath glob after the import swap', () => {
        const marker = {};
        const adminDef = new FilterDefinition(10, class Admin {}, 'src/controllers/admin/**/*.ts');
        adminDef.filter = marker;
        const publicDef = new FilterDefinition(20, class Pub {}, 'src/controllers/public/**/*.ts');
        publicDef.filter = {};

        const matched = FilterMatcher.findMatchingFilters(
            'src/controllers/admin/AdminController.ts',
            [adminDef, publicDef],
        );

        expect(matched).toHaveLength(1);
        expect(matched[0]).toBe(marker);
    });
});
