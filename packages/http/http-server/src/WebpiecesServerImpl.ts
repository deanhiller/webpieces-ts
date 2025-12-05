import express, {Express, NextFunction, Request, Response} from 'express';
import {Container, ContainerModule, inject, injectable} from 'inversify';
import {buildProviderModule} from '@inversifyjs/binding-decorators';
import {
    ExpressRouteHandler,
    getRoutes,
    MethodMeta,
    provideSingleton,
    RouteBuilderImpl,
    WebAppMeta,
} from '@webpieces/http-routing';
import {WebpiecesServer} from './WebpiecesServer';
import {WebpiecesMiddleware} from './WebpiecesMiddleware';
import {RequestContext} from '@webpieces/core-context';

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
@provideSingleton()
@injectable()
export class WebpiecesServerImpl implements WebpiecesServer {
    private meta!: WebAppMeta;
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
        @inject(RouteBuilderImpl) private routeBuilder: RouteBuilderImpl,
        @inject(WebpiecesMiddleware) private middleware: WebpiecesMiddleware,
    ) {}

    /**
     * Initialize the server (DI container, routes, filters).
     * This is called by WebpiecesFactory.create() after resolving this class from DI.
     * This method is internal and not exposed on the WebpiecesServer interface.
     *
     * @param webpiecesContainer - The framework container
     * @param meta - User-provided WebAppMeta with DI modules and routes
     * @param overrides - Optional ContainerModule for test overrides (loaded LAST)
     */
    /**
     * Initialize the server asynchronously.
     * Use this when overrides module contains async operations (e.g., rebind() in new Inversify).
     *
     * @param webpiecesContainer - The framework container
     * @param meta - User-provided WebAppMeta with DI modules and routes
     * @param overrides - Optional ContainerModule for test overrides (loaded LAST)
     */
    async initialize(
        webpiecesContainer: Container,
        meta: WebAppMeta,
        overrides?: ContainerModule
    ): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.webpiecesContainer = webpiecesContainer;
        this.meta = meta;

        // Create application container as child of framework container
        this.appContainer = new Container({ parent: this.webpiecesContainer });

        // Set container on RouteBuilder (late binding - appContainer didn't exist in constructor)
        this.routeBuilder.setContainer(this.appContainer);

        // 1. Load DI modules asynchronously
        await this.loadDIModules(overrides);

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
     * @param overrides - Optional ContainerModule for test overrides (loaded LAST to override bindings)
     */
    private async loadDIModules(overrides?: ContainerModule): Promise<void> {
        const modules = this.meta.getDIModules();

        // Load buildProviderModule to auto-scan for @provideSingleton decorators
        await this.appContainer.load(buildProviderModule());

        // Load all modules into application container
        // (webpiecesContainer is currently empty, reserved for future framework bindings)
        for (const module of modules) {
            await this.appContainer.load(module);
        }

        // Load overrides LAST so they can override existing bindings
        if (overrides) {
            await this.appContainer.load(overrides);
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

        // Layer 2: Request/Response Logging
        this.app.use(this.middleware.logNextLayer.bind(this.middleware));

        // Register routes
        const routeCount = this.registerExpressRoutes();

        // Start listening - wrap in Promise
        const promise = new Promise<void>((resolve, reject) => {
            this.server = this.app!.listen(this.port, (error?: Error) => {
                if (error) {
                    console.error(`[WebpiecesServer] Failed to start server:`, error);
                    reject(error);
                    return;
                }
                console.log(`[WebpiecesServer] Server listening on http://localhost:${this.port}`);
                console.log(`[WebpiecesServer] Registered ${routeCount} routes`);
                resolve();
            });
        });

        await promise;
    }

    /**
     * Register Express routes - the SINGLE loop over routes.
     * For each route: createHandler (sets up filter chain) → wrapExpress → registerHandler.
     *
     * @returns Number of routes registered
     */
    private registerExpressRoutes(): number {
        if (!this.app) {
            throw new Error('Express app not initialized');
        }

        const routes = this.routeBuilder.getRoutes();
        let count = 0;

        for (const routeWithMeta of routes) {
            const service = this.routeBuilder.createRouteHandler(routeWithMeta);
            const routeMeta = routeWithMeta.definition.routeMeta;

            // Create ExpressWrapper directly (handles full request/response cycle)
            const wrapper = this.middleware.createExpressWrapper(service, routeMeta);

            this.registerHandler(
                routeMeta.httpMethod,
                routeMeta.path,
                wrapper.execute.bind(wrapper),
            );
            count++;
        }

        return count;
    }

    registerHandler(httpMethod: string, path: string, expressHandler: ExpressRouteHandler) {
        if (!this.app) {
            throw new Error('Express app not initialized');
        }

        switch (httpMethod.toLowerCase()) {
            case 'get':
                this.app.get(path, expressHandler);
                break;
            case 'post':
                this.app.post(path, expressHandler);
                break;
            case 'put':
                this.app.put(path, expressHandler);
                break;
            case 'delete':
                this.app.delete(path, expressHandler);
                break;
            case 'patch':
                this.app.patch(path, expressHandler);
                break;
            default:
                console.warn(`[WebpiecesServer] Unknown HTTP method: ${httpMethod}`);
        }
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
                    console.error('[WebpiecesServer] Error stopping server:', err);
                    reject(err);
                    return;
                }
                console.log('[WebpiecesServer] Server stopped');
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
     * @param apiPrototype - The API prototype class with routing decorators (can be abstract)
     * @returns A proxy that implements the API interface
     *
     * Example:
     * ```typescript
     * const saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
     * const response = await saveApi.save(request);
     * ```
     */
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        if (!this.initialized) {
            throw new Error('Server not initialized. Call initialize() before createApiClient().');
        }

        // Get routes from the API prototype using decorators (loops over API methods, NOT all routes)
        const apiMethods = getRoutes(apiPrototype);

        // Create proxy object
        const proxy: Record<string, unknown> = {};

        // Loop over API methods and create proxy functions
        for (const routeMeta of apiMethods) {
            const methodName = routeMeta.methodName;
            const httpMethod = routeMeta.httpMethod.toUpperCase();
            const path = routeMeta.path;

            // Create invoker service ONCE (sets up filter chain once, not on every call!)
            const service = this.routeBuilder.createRouteInvoker(httpMethod, path);

            // Proxy method creates MethodMeta and calls the pre-configured service
            // IMPORTANT: Tests MUST wrap calls in RequestContext.run() themselves
            // This forces explicit context setup in tests, matching production behavior
            proxy[methodName] = async (requestDto: unknown): Promise<unknown> => {
                // Verify we're inside an active RequestContext
                // This helps test authors know they need to wrap their test in RequestContext.run()
                if (!RequestContext.isActive()) {
                    throw new Error(
                        `RequestContext not active for ${routeMeta.controllerClassName}.${routeMeta.methodName}(). ` +
                        `Tests must wrap API calls in RequestContext.run(() => { ... }). ` +
                        `Example:\n` +
                        `  await RequestContext.run(async () => {\n` +
                        `    const response = await apiClient.${methodName}(request);\n` +
                        `  });\n` +
                        `This matches production behavior where ExpressWrapper.execute() establishes the context.`
                    );
                }

                // Create MethodMeta without headers (test mode - no HTTP involved)
                // requestHeaders is optional, so we can omit it
                const meta = new MethodMeta(routeMeta, undefined, requestDto);
                const responseWrapper = await service.invoke(meta);
                return responseWrapper.response;
            };
        }

        return proxy as T;
    }
}
