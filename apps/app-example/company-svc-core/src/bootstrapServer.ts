import express from 'express';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { ApiFactory, WebpiecesRouter, setupRuntime, RuntimeSetupOptions } from '@webpieces/http-routing';
import { toError, Logger, LogManager } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { BootstrapOptions } from './BootstrapOptions';
import { CompanySetupOptions } from './CompanySetupOptions';

/**
 * setupCompanyRuntime - the thin COMPANY wrapper over the framework {@link setupRuntime}. It
 * supplies the org-wide {@link CompanyHeaders} (the one company-specific input) and forwards the
 * rest, so the whole canonical sequence (headers → logging → router → the app's routes/filters
 * block → {@link ApiFactory}) lives in the framework and is reused verbatim. Every company express
 * service + its tests call this with their options + a routes block; tests pass their own
 * {@link CompanySetupOptions.loggerFactory}, else identical to prod.
 */
export async function setupCompanyRuntime(
    options: CompanySetupOptions,
    configureRoutes: (router: WebpiecesRouter) => void,
): Promise<ApiFactory> {
    return setupRuntime(
        new RuntimeSetupOptions(
            options.loggerFactory,
            options.svrHeaders,
            CompanyHeaders.getAllHeaders(),
            /*platformHeaders*/ true,
            options.modules,
            options.appOverrides,
            options.config,
        ),
        configureRoutes,
    );
}

/**
 * bootstrapServer - the ONE shared startup every company express service uses.
 *
 * The app supplies its port/logName + a `buildApiFactory` — the SAME per-app builder its
 * tests call, which runs {@link setupCompanyRuntime} and declares its routes/filters. So
 * each entry point stays tiny and the server + tests share one API-surface declaration:
 *
 * ```ts
 * bootstrapServer(new BootstrapOptions(8200, 'Server'), buildClientServerApiFactory);
 * ```
 *
 * Sequence: buildApiFactory() (HeaderRegistry → log backend → router+container → addRoutes/
 * addFilter) → WebpiecesExpressRouter.bindAndStartExpress (express + CORS + error handling +
 * route mounting + listen) → park on SIGTERM/SIGINT → on startup error, log + exit(1).
 * Express lifecycle lives entirely in @webpieces/http-server (WebpiecesExpressRouter).
 */
export async function bootstrapServer(
    options: BootstrapOptions,
    buildApiFactory: () => Promise<ApiFactory>,
): Promise<void> {
    const log = LogManager.getLogger(options.logName);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        // The per-app builder runs the shared headers→logging→router sequence and declares
        // its routes/filters, returning a ready ApiFactory (the same call the tests make).
        const apiFactory = await buildApiFactory();

        log.info(`[${options.logName}] Starting server...`);

        const port = parseInt(process.env['PORT'] || String(options.port), 10);
        await new WebpiecesExpressRouter(apiFactory).bindAndStartExpress(express(), port);
        log.info(`[${options.logName}] Listening on port ${port}`);

        await keepAliveUntilSignal(log, options.logName);
    } catch (err: unknown) {
        const error = toError(err);
        log.error(`[${options.logName}] Error during startup:`, error);
        // webpieces-disable no-process-exit-outside-main -- top-level server startup boundary: service entry points call bootstrapServer() directly (no main()/runMain wrapper), so this IS the terminal exit site.
        process.exit(1);
    }
}

/**
 * Keep the process alive until SIGTERM/SIGINT (graceful-shutdown seam).
 */
function keepAliveUntilSignal(log: Logger, logName: string): Promise<void> {
    return new Promise<void>((resolve: () => void) => {
        process.on('SIGTERM', () => {
            log.info(`[${logName}] Received SIGTERM signal, shutting down...`);
            resolve();
        });
        process.on('SIGINT', () => {
            log.info(`[${logName}] Received SIGINT signal, shutting down...`);
            resolve();
        });
    });
}
