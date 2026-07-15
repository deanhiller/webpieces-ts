import { ContainerModule } from 'inversify';
import { ApiCallContextHolder, HeaderRegistry, LoggerFactory, LogManager } from '@webpieces/core-util';
import { RequestContextApiCallContext } from '@webpieces/core-context';
import { WebpiecesConfig } from './WebpiecesConfig';
import { WebpiecesRouterFactory } from './WebpiecesRouter';
import { AppModules } from './AppModules';
import { ApiFactory } from './ApiFactory';

/**
 * RuntimeSetupOptions - the environment/wiring inputs to {@link setupRuntime} (everything NOT
 * declared by the app's {@link AppModules}): the logging backend, whether to include the platform
 * default headers, and config. Data-only structure (a class, per the webpieces guidelines). The
 * app's own binding modules + route groups + headers come from the AppModules passed alongside;
 * the test-override module is the separate `appOverrides` param of {@link setupRuntime}.
 *
 * Headers: {@link HeaderRegistry.configure} registers the platform defaults (when
 * `platformHeaders` is true) plus AppModules.getHeaders() (by convention the company-wide set).
 */
export class RuntimeSetupOptions {
    constructor(
        /** Logging backend to install (LogManager.setFactory). */
        public readonly loggerFactory: LoggerFactory,
        /** Include the webpieces platform default headers. */
        public readonly platformHeaders: boolean = true,
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
 *   3. build the router + DI container (from appModules.getBindingModules())
 *   4. configure each appModules.getRoutingModules() onto the router (addRoutes/addFilter)
 *
 * and returns the built {@link ApiFactory} — `apiClients()` for a transport to bind, or
 * `createApiClient()` for in-process tests. There is NO express (or any transport) here; a
 * transport adapter (e.g. WebpiecesExpressRouter in @webpieces/http-server) serves the result.
 */
export async function setupRuntime(
    options: RuntimeSetupOptions,
    appModules: AppModules,
    /** A single DI module loaded LAST so tests can rebind bindings to mocks.
     * Or special case servers that want to override specific things */
    appOverrides?: ContainerModule,
): Promise<ApiFactory> {
    // 1. Register the global HeaderRegistry FIRST (this service's own keys come from AppModules).
    HeaderRegistry.configure(appModules.getHeaders(), options.platformHeaders);

    // 2. Install the logging backend ONCE, before anything else logs.
    LogManager.setFactory(options.loggerFactory);

    // 2b. Bind the SERVER ApiCallContext so LogApiCall (browser-safe core-util) stamps the structured
    // `api` tag into the real RequestContext. Installed here — the one startup that runs on EVERY
    // server — so both inbound (LogApiFilter) and outbound (clients) log lines carry jsonPayload.api.
    ApiCallContextHolder.install(new RequestContextApiCallContext());

    // 3. Build the node-only router + DI container.
    const router = await WebpiecesRouterFactory.create({
        appBindings: [...appModules.getBindingModules()],
        appOverrides: appOverrides,
        config: options.config ?? new WebpiecesConfig(),
    });

    // 4. Let each route group declare its routes + filters, then hand back the consumer surface.
    for (const routeModule of appModules.getRoutingModules()) {
        routeModule.configure(router);
    }
    return router;
}
