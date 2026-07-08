import { ContainerModule } from 'inversify';
import { ContextKey, HeaderRegistry, LoggerFactory, LogManager } from '@webpieces/core-util';
import { WebpiecesConfig } from './WebpiecesConfig';
import { WebpiecesRouter, WebpiecesRouterFactory } from './WebpiecesRouter';
import { ApiFactory } from './ApiFactory';

/**
 * RuntimeSetupOptions - inputs to {@link setupRuntime}. Data-only structure (a class, per the
 * webpieces guidelines). A company/app layer supplies its own header tiers + logger + modules;
 * the framework runs the canonical startup sequence and hands back a transport-free ApiFactory.
 *
 * Header tiers mirror {@link HeaderRegistry.configure}: platform defaults + org/company keys +
 * this-service keys.
 */
export class RuntimeSetupOptions {
    constructor(
        /** Logging backend to install (LogManager.setFactory). */
        public readonly loggerFactory: LoggerFactory,
        /** This service's own context keys. */
        public readonly svrHeaders: ContextKey[] = [],
        /** Org/company-wide shared context keys (the company layer passes these in). */
        public readonly companyHeaders: ContextKey[] = [],
        /** Include the webpieces platform default headers. */
        public readonly platformHeaders: boolean = true,
        /** App DI ContainerModules to load. */
        public readonly modules: ContainerModule[] = [],
        /** A single DI module loaded LAST so tests can rebind bindings to mocks. */
        public readonly appOverrides?: ContainerModule,
        /** Optional WebpiecesConfig (e.g. recording flags); defaults to a fresh one. */
        public readonly config?: WebpiecesConfig,
    ) {}
}

/**
 * setupRuntime - the ONE canonical, TRANSPORT-FREE startup sequence, reusable by any company/app
 * AND any framework adapter (express, fastify, a serverless handler, ...). It runs, in the correct
 * fail-fast order:
 *
 *   1. HeaderRegistry.configure  (filters read it at construction; logging masks off it)
 *   2. LogManager.setFactory     (fails fast unless the registry is configured first)
 *   3. build the router + DI container
 *   4. run the caller's `configureRoutes(router)` block (addRoutes/addFilter)
 *
 * and returns the built {@link ApiFactory} — `apiClients()` for a transport to bind, or
 * `createApiClient()` for in-process tests. There is NO express (or any transport) here; a
 * transport adapter (e.g. WebpiecesExpressRouter in @webpieces/http-server) serves the result.
 */
export async function setupRuntime(
    options: RuntimeSetupOptions,
    configureRoutes: (router: WebpiecesRouter) => void,
): Promise<ApiFactory> {
    // 1. Register the global HeaderRegistry FIRST.
    HeaderRegistry.configure(options.svrHeaders, options.companyHeaders, options.platformHeaders);

    // 2. Install the logging backend ONCE, before anything else logs.
    LogManager.setFactory(options.loggerFactory);

    // 3. Build the node-only router + DI container.
    const router = await WebpiecesRouterFactory.create({
        appBindings: [...options.modules],
        appOverrides: options.appOverrides,
        config: options.config ?? new WebpiecesConfig(),
    });

    // 4. Let the caller declare its routes + filters, then hand back the consumer surface.
    configureRoutes(router);
    return router;
}
