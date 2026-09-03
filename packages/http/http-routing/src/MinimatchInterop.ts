import type { minimatch as MinimatchNamed } from 'minimatch';

/**
 * The `(path, pattern, options?) => boolean` callable that EVERY minimatch major has exposed —
 * only the wrapper around it changed between versions.
 */
export type MinimatchFn = typeof MinimatchNamed;

/**
 * The two export shapes minimatch has shipped:
 *   - v5+ : `exports.minimatch = minimatch` — a MODULE carrying a named `minimatch` export.
 *   - v3/v4: `module.exports = minimatch` — the module IS the function, with NO named export.
 */
type MinimatchExport = MinimatchFn & { minimatch?: MinimatchFn };

/**
 * Resolves whichever minimatch actually got linked into the callable both shapes provide.
 *
 * WHY THIS EXISTS (issue #747). `import { minimatch } from 'minimatch'` compiles to
 * `minimatch_1.minimatch`, which is `undefined` against minimatch v3 — and v3 is what a consumer
 * gets whenever pnpm's `node-linker=hoisted` puts an older minimatch at the root and this package
 * receives no nested copy. `@webpieces/rules-config` crashed that way; `FilterMatcher` had the
 * identical call and was surviving only by luck of nesting.
 *
 * THIS IS NOT A WEBPIECES COMPATIBILITY SHIM. It keeps no old spelling of any webpieces surface
 * alive — there is exactly one exported `minimatch` binding here, and no caller can choose a
 * second one. It reconciles an EXTERNAL library's two export shapes, which webpieces neither owns
 * nor can delete, at the one boundary where that library enters this package.
 */
export class MinimatchInterop {
    /**
     * @param loaded whatever `require('minimatch')` produced in the consumer's tree
     * @returns the matcher function, from the named export when present, else the module itself
     */
    resolve(loaded: MinimatchExport): MinimatchFn {
        return loaded.minimatch ?? loaded;
    }
}

/** The interop-resolved matcher. Import THIS, never `{ minimatch } from 'minimatch'`. */
export const minimatch: MinimatchFn = new MinimatchInterop().resolve(
    require('minimatch') as MinimatchExport,
);
