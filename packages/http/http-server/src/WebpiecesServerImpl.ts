import express, {Express} from 'express';
import {Container, ContainerModule, inject, injectable} from 'inversify';
import {buildProviderModule} from '@inversifyjs/binding-decorators';
import {
    provideSingleton,
    RouteBuilderImpl,
    WebAppMeta,
    WEBAPP_META_TOKEN,
} from '@webpieces/http-routing';
import {WebpiecesServer} from './WebpiecesServer';
import {WebpiecesMiddleware} from './WebpiecesMiddleware';
import {WebpiecesRouteCreator} from './WebpiecesRouteCreator';
import {InProcessApiClientFactory} from './InProcessApiClientFactory';
import {LogManager} from '@webpieces/core-util';

/**
 * WebpiecesServerImpl - Internal server implementation.
 *
 * This class implements the WebpiecesServer interface and contains
 * all the actual server logic. It is created by WebpiecesFactory.create().
 *
 * This class uses a two-container pattern similar to Java WebPieces:
 * 1. webpiecesContainer: Core WebPieces framework bindings
 * 2. appContainer: User's application bindings (child of webpiecesContainer)
 *
 * This separation allows:
 * - Clean separation of concerns
 * - Better testability
 * - Ability to override framework bindings in tests
 *
 * The server:
 * 1. Initializes both DI containers from WebAppMeta.getDIModules()
 * 2. Registers routes using explicit RouteBuilderImpl
 * 3. Creates filter chains
 * 4. Supports both HTTP server mode and testing mode (no HTTP)
 *
 * DI Pattern: This class is registered in webpiecesContainer via @provideSingleton()
 * and resolved by WebpiecesFactory. It receives RouteBuilder via constructor injection.
 */
const log = LogManager.getLogger('WebpiecesServer');

@provideSingleton()
@injectable()
export class WebpiecesServerImpl implements WebpiecesServer {
    private webpiecesContainer!: Container;

    /**
     * Application container: User's application bindings.
     * This is a child container of webpiecesContainer, so it can access
     * framework bindings while keeping app bindings separate.
     */
    private appContainer!: Container;

    private initialized = false;
    private app?: Express;
    private server?: ReturnType<Express['listen']>;
    private port: number = 8200;

    constructor(
        @inject(WEBAPP_META_TOKEN) private meta: WebAppMeta,
        @inject(RouteBuilderImpl) private routeBuilder: RouteBuilderImpl,
        @inject(WebpiecesMiddleware) private middleware: WebpiecesMiddleware,
    ) {}

    /**
     * Initialize the server asynchronously.
     * This is called by WebpiecesFactory.create() after resolving this class from DI.
     * This method is internal and not exposed on the WebpiecesServer interface.
     *
     * @param webpiecesContainer - The framework container
     * @param meta - User-provided WebAppMeta with DI modules and routes
     * @param appOverrides - Optional ContainerModule for app test overrides (loaded LAST)
     */
    async initialize(
        webpiecesContainer: Container,
        appOverrides?: ContainerModule
    ): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.webpiecesContainer = webpiecesContainer;

        // Create application container as child of framework container
        this.appContainer = new Container({ parent: this.webpiecesContainer });

        // Set container on RouteBuilder (late binding - appContainer didn't exist in constructor)
        this.routeBuilder.setContainer(this.appContainer);

        // 1. Load DI modules asynchronously
        await this.loadDIModules(appOverrides);

        // buildProviderModule bound a SEPARATE RouteBuilderImpl into appContainer; make
        // app-side singletons resolve the SAME framework instance that actually holds the
        // registered routes (setContainer + addRoute happen on `this.routeBuilder`). Without
        // this, an app singleton that injects RouteBuilderImpl (e.g. LocalTaskDispatcherImpl,
        // used by InMemoryTaskInvoker) would see an empty route table.
        (await this.appContainer.rebind(RouteBuilderImpl)).toConstantValue(this.routeBuilder);

        // 2. Register routes and filters
        this.registerRoutes();

        this.initialized = true;
    }

    /**
     * Load DI modules from WebAppMeta.
     *
     * Currently, all user modules are loaded into the application container.
     * In the future, we could separate:
     * - WebPieces framework modules -> webpiecesContainer
     * - Application modules -> appContainer
     *
     * For now, everything goes into appContainer which has access to webpiecesContainer.
     *
     * @param appOverrides - Optional ContainerModule for app test overrides (loaded LAST to override bindings)
     */
    private async loadDIModules(appOverrides?: ContainerModule): Promise<void> {
        const modules = this.meta.getDIModules();

        // Load buildProviderModule to auto-scan for @provideSingleton decorators
        await this.appContainer.load(buildProviderModule());

        // Load all modules into application container
        // (webpiecesContainer is currently empty, reserved for future framework bindings)
        for (const module of modules) {
            await this.appContainer.load(module);
        }

        // Load appOverrides LAST so they can override existing bindings
        if (appOverrides) {
            await this.appContainer.load(appOverrides);
        }
    }

    /**
     * Register routes from WebAppMeta.
     *
     * Creates an explicit RouteBuilderImpl instead of an anonymous object.
     * This improves:
     * - Traceability: Can Cmd+Click on addRoute to see implementation
     * - Debugging: Explicit class shows up in stack traces
     * - Understanding: Clear class name vs anonymous object
     */
    private registerRoutes(): void {
        const routeConfigs = this.meta.getRoutes();

        // Configure routes using the explicit RouteBuilder
        for (const routeConfig of routeConfigs) {
            routeConfig.configure(this.routeBuilder);
        }
    }

    /**
     * Start the HTTP server with Express.
     * Returns a Promise that resolves when the server is listening,
     * or rejects if the server fails to start.
     *
     * @param port - The port to listen on (default: 8080)
     * @returns Promise that resolves when server is ready
     */
    async start(port: number = 8200, testMode?: boolean): Promise<void> {
        if (!this.initialized) {
            throw new Error('Server not initialized. Call initialize() before start().');
        }

        this.port = port;

        if(testMode) {
            //In testMode, we eliminate express ENTIRELY and use
            //Router, method filters and controllers so that we can test full stack
            return;
        }

        // Create Express app
        this.app = express();

        // Layer 1: Global Error Handler (OUTERMOST - runs FIRST)
        // Catches all unhandled errors and returns HTML 500 page
        this.app.use(this.middleware.globalErrorHandler.bind(this.middleware));

        // Layer 2: CORS for localhost development
        this.app.use(this.middleware.corsForLocalhost());

        // Layer 3: Request/Response Logging
        this.app.use(this.middleware.logNextLayer.bind(this.middleware));

        // Register routes via the shared adapter (same code path as the
        // embeddable WebpiecesRouteCreator used by legacy Express apps)
        const routeCreator = new WebpiecesRouteCreator(
            this.app,
            this.appContainer,
            this.routeBuilder,
            this.middleware,
        );
        const routeCount = routeCreator.mountRegisteredRoutes();

        // Start listening - wrap in Promise
        const promise = new Promise<void>((resolve, reject) => {
            this.server = this.app!.listen(this.port, (error?: Error) => {
                if (error) {
                    log.error(`[WebpiecesServer] Failed to start server:`, error);
                    reject(error);
                    return;
                }
                log.info(`[WebpiecesServer] Server listening on http://localhost:${this.port}`);
                log.info(`[WebpiecesServer] Registered ${routeCount} routes`);
                resolve();
            });
        });

        await promise;
    }

    /**
     * Stop the HTTP server.
     * Returns a Promise that resolves when the server is stopped,
     * or rejects if there's an error stopping the server.
     *
     * @returns Promise that resolves when server is stopped
     */
    async stop(): Promise<void> {
        if (!this.server) {
            return;
        }

        return new Promise<void>((resolve, reject) => {
            this.server!.close((err?: Error) => {
                if (err) {
                    log.error('[WebpiecesServer] Error stopping server:', err);
                    reject(err);
                    return;
                }
                log.info('[WebpiecesServer] Server stopped');
                resolve();
            });
        });
    }

    /**
     * Get the application DI container.
     *
     * Useful for testing to verify state or access services directly.
     *
     * @returns The application Container
     */
    getContainer(): Container {
        return this.appContainer;
    }

    /**
     * Create an API client proxy for testing.
     *
     * This creates a client that routes calls through the full filter chain
     * and controller, but WITHOUT any HTTP overhead. Perfect for testing!
     *
     * The client uses the ApiPrototype class to discover routes via decorators,
     * then creates pre-configured invoker functions for each API method.
     *
     * IMPORTANT: This loops over the API methods (from decorators), NOT all routes.
     * For each API method, it sets up the filter chain ONCE during proxy creation,
     * so subsequent calls reuse the same filter chain (efficient!).
     *
     * @param apiPrototype - The abstract API prototype whose routing decorators declare the routes
     * @returns A proxy that implements the API interface
     *
     * Example:
     * ```typescript
     * const saveApi = server.createApiClient<SaveApi>(SaveApi);
     * const response = await saveApi.save(request);
     * ```
     */
    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        if (!this.initialized) {
            throw new Error('Server not initialized. Call initialize() before createApiClient().');
        }

        // Delegates to the shared factory (same code path as WebpiecesRouteCreator.createApiClient)
        if (!this.clientFactory) {
            this.clientFactory = new InProcessApiClientFactory(this.routeBuilder);
        }
        return this.clientFactory.createApiClient(apiPrototype);
    }

    private clientFactory?: InProcessApiClientFactory;
}
