import { Container, ContainerModule, inject } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { DocumentDesign } from '@webpieces/core-util';
import { provideFrameworkSingleton, buildFrameworkModule } from '@webpieces/core-context';
import { RouteBuilderImpl } from './RouteBuilderImpl';
import { ApiRoutingFactory, ClassType } from './ApiRoutingFactory';
import { FilterDefinition } from './WebAppMeta';
import { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';
import { InProcessApiClientFactory } from './InProcessApiClientFactory';

/**
 * Options for {@link WebpiecesRouterFactory.create}.
 *
 * appBindings  - REQUIRED DI ContainerModules to load (framework + app), e.g.
 *                [WebpiecesModule, CompanyHeadersModule, AppModule]. Loaded after the
 *                @provideSingleton auto-scan so they can add/override bindings.
 * appOverrides - A single ContainerModule loaded LAST so tests can rebind real
 *                controllers/clients to mocks (see @webpieces/core-mock createMock()).
 */
export interface WebpiecesRouterOptions {
    appBindings: ContainerModule[];
    appOverrides?: ContainerModule;
}

/**
 * WebpiecesRouter - the node-only heart of a webpieces app: a DI container + a filter
 * chain + an in-process API client. It has NO express dependency, so it runs anywhere
 * node runs and is fully testable with zero HTTP.
 *
 * DI-resolved from the platform container (like the old WebpiecesServerImpl):
 * `@provideSingleton @injectable`, RouteBuilderImpl injected, and the two containers set in
 * initialize(). Built by {@link WebpiecesRouterFactory.create} — never `new`ed by callers.
 *
 * Two-container pattern (mirrors Java WebPieces):
 *  - webpiecesContainer : framework bindings (config token, @DocumentDesign design roots)
 *  - appContainer       : your controllers/filters/modules (a child of the framework one)
 *
 * Usage:
 * ```typescript
 * const router = await WebpiecesRouterFactory.create(new WebpiecesConfig(), {
 *     appBindings: [WebpiecesModule, CompanyHeadersModule],
 * });
 * router.addRoutes(SaveApi, SaveController);
 * router.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));                 // api tier
 * router.addFilter(new FilterDefinition(1950, ServiceAuthFilter, '*', 'express')); // express tier
 *
 * // test (no express): runs the api-tier filter chain -> controller
 * const api = router.createApiClient(SaveApi);
 * await api.save(new SaveRequest(...));
 * ```
 *
 * To serve real HTTP, hand this router to the express adapter in @webpieces/http-server
 * (bindExpress / bindAndStartExpress) — express lifecycle lives THERE, never here.
 *
 * @DocumentDesign marks it a design root so it appears in http-routing's designed-lib graph.
 */
@DocumentDesign()
@provideFrameworkSingleton()
export class WebpiecesRouter {
    private webpiecesContainer!: Container;
    private appContainer!: Container;

    constructor(
        @inject(RouteBuilderImpl) private readonly routeBuilder: RouteBuilderImpl,
    ) {}

    /**
     * Build the app container (child of the framework container), load the @provideSingleton
     * auto-scan + appBindings + appOverrides, and point the RouteBuilder at it. Called once by
     * the factory after this router is resolved from the framework container.
     */
    async initialize(webpiecesContainer: Container, options: WebpiecesRouterOptions): Promise<void> {
        this.webpiecesContainer = webpiecesContainer;

        // App container is a child so app bindings see framework bindings while staying separate.
        this.appContainer = new Container({ parent: webpiecesContainer });
        this.routeBuilder.setContainer(this.appContainer);

        await this.loadDIModules(options);
    }

    private async loadDIModules(options: WebpiecesRouterOptions): Promise<void> {
        // Load BOTH registries: framework classes (provideFrameworkSingleton) + the client's
        // own @provideSingleton classes (binding-decorators global). A client's
        // buildProviderModule() only ever contains the client's classes — never framework internals.
        await this.appContainer.load(buildFrameworkModule());
        await this.appContainer.load(buildProviderModule());

        // Load all modules into application container
        // (webpiecesContainer is currently empty, reserved for future framework bindings)
        for (const module of options.appBindings) {
            await this.appContainer.load(module);
        }

        // Load appOverrides LAST so they can override existing bindings
        if (options.appOverrides) {
            await this.appContainer.load(options.appOverrides);
        }
    }

    /**
     * Wire an API prototype (with @ApiPath/@Endpoint decorators) to its controller.
     * The controller is resolved from the container at request time.
     */
    addRoutes<TApi, TController extends TApi>(
        api: ClassType<TApi>,
        controller: ClassType<TController>,
    ): this {
        new ApiRoutingFactory(api, controller).configure(this.routeBuilder);
        return this;
    }

    /**
     * Register a filter. Defaults to the 'api' tier (runs in-process AND over HTTP);
     * pass a 'express'-tier FilterDefinition for transport-boundary filters.
     */
    addFilter(filter: FilterDefinition): this {
        this.routeBuilder.addFilter(filter);
        return this;
    }

    /**
     * Create an in-process API client that runs the api-tier filter chain + controller
     * with NO express/HTTP. The primary path for tests and node-only callers.
     */
    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        return new InProcessApiClientFactory(this.routeBuilder).createApiClient(apiPrototype);
    }

    /** The application DI container (child of the framework container). */
    getContainer(): Container {
        return this.appContainer;
    }

    /** The framework container (holds the config token + @DocumentDesign design roots). */
    getFrameworkContainer(): Container {
        return this.webpiecesContainer;
    }

    /** The route table + filter chain. Used by the express adapter to mount HTTP routes. */
    getRouteBuilder(): RouteBuilderImpl {
        return this.routeBuilder;
    }
}

/**
 * Builds a {@link WebpiecesRouter}: constructs the platform container (mirrors
 * WebpiecesServerFactory.create), RESOLVES the router from DI, then initializes its app child
 * container with the @provideSingleton auto-scan + appBindings + optional test overrides.
 */
export class WebpiecesRouterFactory {
    static async create(
        config: WebpiecesConfig,
        options: WebpiecesRouterOptions,
    ): Promise<WebpiecesRouter> {
        // Platform (framework) container — build via buildFrameworkModule so framework
        // singletons (WebpiecesRouter, RouteBuilderImpl) come from the webpieces registry,
        // NOT the client's global one.
        const webpiecesContainer = new Container();
        webpiecesContainer.bind(WEBPIECES_CONFIG_TOKEN).toConstantValue(config);
        await webpiecesContainer.load(buildFrameworkModule());

        // Resolve the router from the container (NOT new'd) so @DocumentDesign + DI hold.
        const router = webpiecesContainer.get(WebpiecesRouter);
        await router.initialize(webpiecesContainer, options);
        return router;
    }
}
