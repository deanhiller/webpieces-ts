import express from 'express';
import { ContainerModule } from 'inversify';
import { WebpiecesExpress } from '@webpieces/http-server';
import {
    WebpiecesConfig,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { toError, Logger, LogManager, HeaderRegistry, ContextKey } from '@webpieces/core-util';
import { CompanyLogging, CompanyHeaders } from '@webpieces/company-core';
import { BootstrapOptions } from './BootstrapOptions';

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
 * bootstrapServer - the ONE shared startup every company express service uses.
 *
 * The app supplies its options and a `configure` callback that adds its routes/filters
 * to the router. bootstrapServer owns the standard sequence so each entry point stays tiny:
 *
 * ```ts
 * bootstrapServer(new BootstrapOptions(8200, 'Server', factory, [InversifyModule]), (router) => {
 *     router.addFilter(new FilterDefinition(2000, ContextFilter, '*'));
 *     router.addRoutes(SaveApi, SaveController);
 * });
 * ```
 *
 * Sequence: install the log backend (bunyan/winston seam) → createCompanyRouter →
 * app configure(router) → WebpiecesExpress.bindAndStartExpress (express + CORS + error
 * handling + route mounting + listen) → park on SIGTERM/SIGINT → on startup error, log + exit(1).
 * Express lifecycle lives entirely in @webpieces/http-server (WebpiecesExpress).
 */
export async function bootstrapServer(
    options: BootstrapOptions,
    configure: (router: WebpiecesRouter) => void,
): Promise<void> {
    // Register the global HeaderRegistry FIRST — logging masks/keys off it, and
    // LogManager.setFactory fails fast if the registry is not configured yet.
    configureCompanyHeaders(options.svrHeaders);

    // Install the server-side logging backend ONCE, before anything else logs.
    CompanyLogging.configure(options.loggerFactory);

    const log = LogManager.getLogger(options.logName);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        log.info(`[${options.logName}] Starting server...`);

        const router = await createCompanyRouter({ modules: options.modules });
        configure(router);

        const port = parseInt(process.env['PORT'] || String(options.port), 10);
        await new WebpiecesExpress(router).bindAndStartExpress(express(), port);
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
