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
 * correct fail-fast order and returns a ready {@link WebpiecesRouter}:
 *
 *   1. HeaderRegistry.configure  (filters read it at construction; logging masks off it)
 *   2. LogManager.setFactory     (fails fast unless the registry is configured first)
 *   3. build the router + DI container
 *
 * Shared by ALL three startup scenarios so none of them re-derive (and drift on) this
 * order: the express server (via {@link bootstrapServer}), the in-process createApiClient
 * tests, and the legacy-server example (which then hands `router.getContainer()` to
 * WebpiecesRouteCreator). Tests pass their own {@link CompanySetupOptions.loggerFactory};
 * everything else is identical to production.
 */
export async function setupCompanyRuntime(options: CompanySetupOptions): Promise<WebpiecesRouter> {
    // 1. Register the global HeaderRegistry FIRST.
    configureCompanyHeaders(options.svrHeaders);

    // 2. Install the logging backend ONCE, before anything else logs.
    CompanyLogging.configure(options.loggerFactory);

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
 * Sequence: {@link setupCompanyRuntime} (HeaderRegistry → log backend → router+container) →
 * app configure(router) → WebpiecesExpress.bindAndStartExpress (express + CORS + error
 * handling + route mounting + listen) → park on SIGTERM/SIGINT → on startup error, log + exit(1).
 * Express lifecycle lives entirely in @webpieces/http-server (WebpiecesExpress).
 */
export async function bootstrapServer(
    options: BootstrapOptions,
    configure: (router: WebpiecesRouter) => void,
): Promise<void> {
    const log = LogManager.getLogger(options.logName);

    // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- Top-level server startup needs to catch and exit on error
    try {
        // Headers → logging → router: the ONE shared sequence (also used by tests and
        // the legacy-server example) so every entry point starts identically.
        const router = await setupCompanyRuntime(
            new CompanySetupOptions(options.loggerFactory, options.modules, options.svrHeaders),
        );

        log.info(`[${options.logName}] Starting server...`);
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
