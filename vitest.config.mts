import { defineConfig, type Plugin } from 'vitest/config';
import { transform } from '@swc/core';
import * as path from 'path';

/**
 * Vitest transforms TS with esbuild, which deliberately does NOT emit
 * `emitDecoratorMetadata` (`design:paramtypes`). Inversify inject-by-type (a bare
 * `@injectable` class with a concrete-typed constructor param, no `@inject`) NEEDS that
 * metadata, so without this plugin those classes resolve as "0 constructor args" under
 * vitest even though tsc builds them fine. Re-transform every non-node_modules TS file with
 * SWC (already a devDependency) so decorator metadata is emitted — matching the tsc build.
 */
function swcDecoratorMetadata(): Plugin {
    return {
        name: 'swc-decorator-metadata',
        enforce: 'pre',
        async transform(code: string, id: string) {
            if (id.includes('/node_modules/') || !/\.tsx?($|\?)/.test(id)) return null;
            const result = await transform(code, {
                filename: id,
                sourceMaps: true,
                jsc: {
                    parser: { syntax: 'typescript', decorators: true },
                    transform: { legacyDecorator: true, decoratorMetadata: true },
                    target: 'es2022',
                    keepClassNames: true,
                },
            });
            return { code: result.code, map: result.map };
        },
    };
}

export default defineConfig({
    plugins: [swcDecoratorMetadata()],
    // SWC (above) is the sole TS transformer. Leaving vite's esbuild pass on would DOUBLE-transform
    // and rename shadowed class expressions (`let X = class X {}` -> inner becomes `X2`), corrupting
    // `class.name` (breaks name-derived logic like getQueueName).
    esbuild: false,
    resolve: {
        alias: {
            '@webpieces/core-context': path.resolve(__dirname, 'packages/core/core-context/src/index.ts'),
            '@webpieces/core-mock': path.resolve(__dirname, 'packages/core/core-mock/src/index.ts'),
            '@webpieces/core-util': path.resolve(__dirname, 'packages/core/core-util/src/index.ts'),
            '@webpieces/wp-logging': path.resolve(__dirname, 'packages/core/core-util/src/index.ts'),
            '@webpieces/http-api': path.resolve(__dirname, 'packages/core/core-util/src/index.ts'),
            '@webpieces/http-routing': path.resolve(__dirname, 'packages/http/http-routing/src/index.ts'),
            '@webpieces/http-filters': path.resolve(__dirname, 'packages/http/http-filters/src/index.ts'),
            '@webpieces/http-server': path.resolve(__dirname, 'packages/http/http-server/src/index.ts'),
            '@webpieces/http-client-core': path.resolve(__dirname, 'packages/http/http-client-core/src/index.ts'),
            '@webpieces/http-client-browser': path.resolve(__dirname, 'packages/http/http-client-browser/src/index.ts'),
            '@webpieces/http-client-node': path.resolve(__dirname, 'packages/http/http-client-node/src/index.ts'),
            '@webpieces/gcp-identity': path.resolve(__dirname, 'packages/cloud/gcp-identity/src/index.ts'),
            '@webpieces/cloudtasks-client': path.resolve(__dirname, 'packages/cloud/cloudtasks-client/src/index.ts'),
            '@webpieces/client-server-api': path.resolve(__dirname, 'apps/app-example/client-server-api/src/index.ts'),
            '@webpieces/server2-api': path.resolve(__dirname, 'apps/app-example/server2-api/src/index.ts'),
            '@webpieces/company-core': path.resolve(__dirname, 'apps/app-example/company-core/src/index.ts'),
            '@webpieces/company-svc-core': path.resolve(__dirname, 'apps/app-example/company-svc-core/src/index.ts'),
            '@webpieces/rules-config': path.resolve(__dirname, 'packages/tooling/rules-config/src/index.ts'),
            '@webpieces/ai-hook-rules': path.resolve(__dirname, 'packages/tooling/ai-hook-rules/src/index.ts'),
            '@webpieces/eslint-rules': path.resolve(__dirname, 'packages/tooling/eslint-rules/src/index.ts'),
            '@webpieces/code-rules': path.resolve(__dirname, 'packages/tooling/code-rules/src/index.ts'),
            '@webpieces/nx-webpieces-rules': path.resolve(__dirname, 'packages/tooling/nx-webpieces-rules/src/index.ts'),
        },
    },
    test: {
        watch: false,
        globals: true,
        environment: 'node',
        include: [
            'packages/*/*/*/{src,tests}/**/*.{test,spec}.{js,ts}',
            'packages/*/*/{src,tests}/**/*.{test,spec}.{js,ts}',
            'apps/*/{src,tests}/**/*.{test,spec}.{js,ts}',
            'apps/*/*/{src,tests}/**/*.{test,spec}.{js,ts}',
        ],
        passWithNoTests: true,
        pool: 'forks',
        poolOptions: {
            forks: {
                maxForks: 2,
            },
        },
    },
});
