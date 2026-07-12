import express from 'express';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { ApiFactory, AppModules, setupRuntime, RuntimeSetupOptions } from '@webpieces/http-routing';
import { toError, LogManager } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { BootstrapOptions } from './BootstrapOptions';
import { CompanySetupOptions } from './CompanySetupOptions';

/**
 * setupCompanyRuntime - the thin COMPANY wrapper over the framework {@link setupRuntime}. It
 * supplies the org-wide {@link CompanyHeaders} (the one company-specific input) and forwards the
 * app's {@link AppModules} (binding modules + route groups + headers) plus the environment options,
 * so the whole canonical sequence (headers → logging → router → the app's route groups →
 * {@link ApiFactory}) lives in the framework and is reused verbatim. Every company express service +
 * its tests call this with the app's `MyAppModules.create()`; tests pass their own
 * {@link CompanySetupOptions} (logger / appOverrides), else identical to prod.
 */
export async function setupCompanyRuntime(
    appModules: AppModules,
    options: CompanySetupOptions = new CompanySetupOptions(),
): Promise<ApiFactory> {
    return setupRuntime(
        new RuntimeSetupOptions(
            options.loggerFactory,
            CompanyHeaders.getAllHeaders(),
            /*platformHeaders*/ true,
            options.appOverrides,
            options.config,
        ),
        appModules,
    );
}

/**
 * bootstrapServer - the ONE shared startup every company express service uses.
 *
 * The app supplies its port/logName + its {@link AppModules} — the SAME `MyAppModules.create()`
 * its tests build, which declares its binding modules + route groups + headers. So each entry
 * point stays tiny and the server + tests share one server-surface declaration:
 *
 * ```ts
 * bootstrapServer(new BootstrapOptions(8200, 'Server'), ClientServerAppModules.create());
 * ```
 *
 * Sequence: setupCompanyRuntime(appModules) (HeaderRegistry → log backend → router+container →
 * route groups) → WebpiecesExpressRouter.bindAndStartExpress (express + CORS + error handling +
 * route mounting + listen) → park on SIGTERM/SIGINT → on startup error, log + exit(1).
 * Express lifecycle lives entirely in @webpieces/http-server (WebpiecesExpressRouter).
 */
export async function bootstrapServer(
    options: BootstrapOptions,
    appModules: AppModules,
    setupOptions: CompanySetupOptions = new CompanySetupOptions(),
): Promise<void> {
    const log = LogManager.getLogger(options.logName);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        // Run the shared headers→logging→router sequence and configure the app's route groups,
        // returning a ready ApiFactory (the same call the tests make).
        const apiFactory = await setupCompanyRuntime(appModules, setupOptions);

        log.info(`[${options.logName}] Starting server...`);

        const port = parseInt(process.env['PORT'] || String(options.port), 10);
        await new WebpiecesExpressRouter(apiFactory).bindAndStartExpress(express(), port);
        log.info(`[${options.logName}] Listening on port ${port}`);
        // The listening socket keeps the process alive; SIGTERM/SIGINT fall through to Node's
        // default (clean, immediate terminate). No keep-alive loop is needed.
    } catch (err: unknown) {
        const error = toError(err);
        log.error(`[${options.logName}] Error during startup:`, error);
        // webpieces-disable no-process-exit-outside-main -- top-level server startup boundary: service entry points call bootstrapServer() directly (no main()/runMain wrapper), so this IS the terminal exit site.
        process.exit(1);
    }
}
