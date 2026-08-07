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
        // The tooling suites shell out to real `git` and to /bin/sh shims. A process spawn costs a few
        // ms on an idle machine but ~100ms once `nx run-many` has several projects going, so per-test
        // cost is dominated by SPAWN COUNT, not by work. That is fixed where it belongs — batched grep
        // (ShimTestkit.ereMatchSet), repo fixtures built once and copied (main-sync-status.spec), one
        // shim run per it() — which took the worst test from ~13s to ~5s under a full parallel run.
        // What is left is inherent: an integration test of a git-driven code path spawns git.
        //
        // 45s, not the old 15s. A spawn from INSIDE a vitest worker costs ~195ms even for a bare `echo`
        // (2.6ms from plain node), so a spec doing ~50 git calls is spawn-bound, and on a loaded machine
        // these integration tests were measured at 15-24s. 15s was not catching hangs, it was failing
        // honest work. 45s still catches a genuine hang while leaving room for a busy CI box.
        //
        // DO NOT RAISE THIS AGAIN for a slow suite. It has already moved once (15s → 45s) and it governs
        // the 400+ runtime/app tests that should fail fast. The `packages/tooling/**` suites — which are
        // spawn-bound integration tests and are the ONLY ones that have ever needed more — get 120s from
        // vitest.setup.mts instead, scoped by path. That file carries the measurements, the reason pool
        // tuning is not the answer, and how to recognise the failure (it reports at FILE level, and which
        // tests blow up moves between runs).
        testTimeout: 45_000,
        hookTimeout: 45_000,
        // Runs once PER TEST FILE, which is what lets it hand the tooling suites a longer budget without
        // touching everyone else's.
        setupFiles: [path.resolve(__dirname, 'vitest.setup.mts')],
        /**
         * NO `reporters` override and NO pool tuning here — both were tried against this repo's
         * `[vitest-worker]: Timeout calling "onTaskUpdate"` failures (a run reported FAILED while
         * printing `307 passed, 0 failed`) and neither is the fix. Recorded so nobody re-adds them:
         *
         *   - `reporters: ['dot']` cannot help. The worker emits `onTaskUpdate` UNCONDITIONALLY;
         *     reporters live only in the MAIN process, so the choice changes rendering, not RPC volume.
         *     Worse under nx: output is a pipe, so non-TTY `DotReporter` does a SYNCHRONOUS write PER
         *     TEST — one real run emitted 638 of them, where the default reporter writes none.
         *   - `maxForks: 1` measured 0 failures once and then 26 failures on the next run at higher
         *     load. Not a fix, just a wider margin.
         *   - `pool: 'threads'` made no difference (182.9ms vs 194.8ms spawn floor).
         *
         * THE ACTUAL CAUSE was an upstream BUG, not our configuration: vitest's `forks.ts` passed the
         * `node:v8` module straight in as birpc options; `v8` has no `timeout` property, so birpc fell
         * back to `DEFAULT_TIMEOUT` = 60s (vitest-dev/vitest#8164). Our suites drive git through
         * `execSync`, which BLOCKS the worker's event loop, and the ack arrives as an IPC message — an
         * I/O event needing a MACROTASK turn that a synchronous test never yields. So acks queued
         * unprocessed for a measured 55-95s, and everything past 60s was reported as a failure.
         *
         * Fixed upstream in #8297 by passing `timeout: -1`, shipped in 4.1.6 and NEVER backported to
         * 3.x. That is why this repo is on vitest >= 4.1.6 — do not downgrade below it.
         */
        pool: 'forks',
    },
});
