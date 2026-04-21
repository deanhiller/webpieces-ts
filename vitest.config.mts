import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@webpieces/core-context': path.resolve(__dirname, 'packages/core/core-context/src/index.ts'),
            '@webpieces/core-util': path.resolve(__dirname, 'packages/core/core-util/src/index.ts'),
            '@webpieces/http-api': path.resolve(__dirname, 'packages/http/http-api/src/index.ts'),
            '@webpieces/http-routing': path.resolve(__dirname, 'packages/http/http-routing/src/index.ts'),
            '@webpieces/http-filters': path.resolve(__dirname, 'packages/http/http-filters/src/index.ts'),
            '@webpieces/http-server': path.resolve(__dirname, 'packages/http/http-server/src/index.ts'),
            '@webpieces/http-client': path.resolve(__dirname, 'packages/http/http-client/src/index.ts'),
            '@webpieces/example-apis': path.resolve(__dirname, 'apps/example-apis/src/index.ts'),
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
