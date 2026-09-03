import { MinimatchInterop, MinimatchFn, minimatch } from './minimatch-interop';
import { isPathExcluded, matchesAnyGlob } from './exclude-paths';

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
        expect(minimatch('libraries/apis/foo.ts', 'libraries/apis/**')).toBe(true);
        expect(minimatch('libraries/other/foo.ts', 'libraries/apis/**')).toBe(false);
    });
});

describe('exclude-paths uses the interop-resolved matcher', () => {
    it('still globs after the import swap', () => {
        expect(isPathExcluded('libraries/foo/index.d.ts', ['**/*.d.ts'])).toBe(true);
        expect(matchesAnyGlob('.github/workflows/deploy.yml', ['**'])).toBe(true);
    });
});
