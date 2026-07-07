import express from 'express';
import { ContainerModule } from 'inversify';
import { WebpiecesExpress, WebpiecesModule } from '@webpieces/http-server';
import {
    WebpiecesConfig,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { toError, Logger, LogManager } from '@webpieces/core-util';
import { CompanyLogging } from '@webpieces/company-core';
import { BootstrapOptions } from './BootstrapOptions';
import { CompanyHeadersModule } from './CompanyHeadersModule';

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
 * Build a node-only {@link WebpiecesRouter} with the standard company DI stack
 * (WebpiecesModule framework headers + CompanyHeadersModule company headers) plus any
 * app modules. Shared by BOTH the production server (bootstrapServer) and tests, so a
 * createApiClient() test exercises the exact same container + filter chain as production.
 */
export async function createCompanyRouter(options: CompanyRouterOptions = {}): Promise<WebpiecesRouter> {
    return WebpiecesRouterFactory.create(options.config ?? new WebpiecesConfig(), {
        appBindings: [WebpiecesModule, CompanyHeadersModule, ...(options.modules ?? [])],
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
        // eslint-disable-next-line @webpieces/no-process-exit-outside-main -- top-level server startup boundary: service entry points call bootstrapServer() directly (no main()/runMain wrapper), so this IS the terminal exit site.
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
