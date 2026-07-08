import express from 'express';
import { ContainerModule } from 'inversify';
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import {
    ApiFactory,
    WebpiecesConfig,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { toError, Logger, LogManager, HeaderRegistry, ContextKey } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { BootstrapOptions } from './BootstrapOptions';
import { CompanySetupOptions } from './CompanySetupOptions';

/**
 * Options for {@link createCompanyRouter}.
 * modules      - app DI modules beyond the standard company set.
 * appOverrides - single module loaded LAST so tests can rebind bindings to mocks.
 * config       - optional WebpiecesConfig (e.g. recording flags); defaults to a fresh one.
 */
export interface CompanyRouterOptions {
    modules?: ContainerModule[];
    appOverrides?: ContainerModule;
    config?: WebpiecesConfig;
}

/**
 * Register the global {@link HeaderRegistry} for a company service: this server's own
 * keys + the shared CompanyHeaders + the webpieces platform defaults. MUST run before
 * the logger is installed (LogManager.setFactory fails fast otherwise) and before the
 * router is built (filters read the registry at construction).
 *
 * Idempotent-friendly for tests: safe to call again with the same inputs.
 */
export function configureCompanyHeaders(svrHeaders: ContextKey[] = []): void {
    HeaderRegistry.configure(svrHeaders, CompanyHeaders.getAllHeaders(), /*platformHeaders*/ true);
}

/**
 * Build a node-only {@link WebpiecesRouter} with the app DI modules. Shared by BOTH the
 * production server (bootstrapServer) and tests, so a createApiClient() test exercises the
 * exact same container + filter chain as production.
 *
 * NOTE: the header system is now a global (HeaderRegistry.configure), NOT DI — callers
 * that use ContextFilter/LogApiFilter must call {@link configureCompanyHeaders} first.
 */
export async function createCompanyRouter(options: CompanyRouterOptions = {}): Promise<WebpiecesRouter> {
    return WebpiecesRouterFactory.create(options.config ?? new WebpiecesConfig(), {
        appBindings: [...(options.modules ?? [])],
        appOverrides: options.appOverrides,
    });
}

/**
 * setupCompanyRuntime - the ONE method that runs the canonical startup sequence in the
 * correct fail-fast order and returns a ready {@link ApiFactory}:
 *
 *   1. HeaderRegistry.configure  (filters read it at construction; logging masks off it)
 *   2. LogManager.setFactory     (fails fast unless the registry is configured first)
 *   3. build the router + DI container
 *
 * Returns the concrete {@link WebpiecesRouter} (the BUILD surface): the per-app
 * `buildXxxApiFactory` helpers call this, use addRoutes/addFilter to declare their routes +
 * filters, then return it narrowed to the {@link ApiFactory} consumer surface — so the express
 * server (via {@link bootstrapServer}), the in-process createApiClient tests, and the
 * legacy-server embed all share one path. Tests pass their own
 * {@link CompanySetupOptions.loggerFactory}; else identical to prod.
 */
export async function setupCompanyRuntime(options: CompanySetupOptions): Promise<WebpiecesRouter> {
    // 1. Register the global HeaderRegistry FIRST.
    configureCompanyHeaders(options.svrHeaders);

    // 2. Install the logging backend ONCE, before anything else logs.
    LogManager.setFactory(options.loggerFactory);

    // 3. Build the node-only router + DI container.
    return createCompanyRouter({
        modules: options.modules,
        appOverrides: options.appOverrides,
        config: options.config,
    });
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
