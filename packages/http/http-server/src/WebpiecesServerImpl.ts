import express, { Express, NextFunction, Request, Response } from 'express';
import { Container, inject, injectable } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import {
    RouteRequest,
    WebAppMeta,
    provideSingleton,
    MethodMeta,
    RouteBuilderImpl, RouteHandler,
} from '@webpieces/http-routing';
import {
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpVendorError,
    HttpUserError,
} from '@webpieces/http-api';
import { toError } from '@webpieces/core-util';
import { WebpiecesServer } from './WebpiecesServer';

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
    private port: number = 8080;

    constructor(@inject(RouteBuilderImpl) private routeBuilder: RouteBuilderImpl) {}

    /**
     * Initialize the server (DI container, routes, filters).
     * This is called by WebpiecesFactory.create() after resolving this class from DI.
     * This method is internal and not exposed on the WebpiecesServer interface.
     *
     * @param webpiecesContainer - The framework container
     * @param meta - User-provided WebAppMeta with DI modules and routes
     */
    initialize(webpiecesContainer: Container, meta: WebAppMeta): void {
        if (this.initialized) {
            return;
        }

        this.webpiecesContainer = webpiecesContainer;
        this.meta = meta;

        // Create application container as child of framework container
        this.appContainer = new Container({ parent: this.webpiecesContainer });

        // Set container on RouteBuilder (late binding - appContainer didn't exist in constructor)
        this.routeBuilder.setContainer(this.appContainer);

        // 1. Load DI modules
        this.loadDIModules();

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
     */
    private loadDIModules(): void {
        const modules = this.meta.getDIModules();

        // Load buildProviderModule to auto-scan for @provideSingleton decorators
        this.appContainer.load(buildProviderModule());

        // Load all modules into application container
        // (webpiecesContainer is currently empty, reserved for future framework bindings)
        for (const module of modules) {
            this.appContainer.load(module);
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
     * Global error handler middleware - catches ALL unhandled errors.
     * Returns HTML 500 error page for any errors that escape the filter chain.
     *
     * This is the outermost safety net - JsonFilter catches JSON API errors,
     * this catches everything else.
     */
    private async globalErrorHandler(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        console.log('🔴 [Layer 1: GlobalErrorHandler] Request START:', req.method, req.path);

        try {
            // await next() catches BOTH:
            // 1. Synchronous throws from next() itself
            // 2. Rejected promises from downstream async middleware
            await next();
            console.log(
                '🔴 [Layer 1: GlobalErrorHandler] Request END (success):',
                req.method,
                req.path,
            );
        } catch (err: unknown) {
            const error = toError(err);
            console.error('🔴 [Layer 1: GlobalErrorHandler] Caught unhandled error:', error);
            if (!res.headersSent) {
                // Return HTML error page (not JSON - JsonFilter handles JSON errors)
                res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Server Error</title></head>
          <body>
            <h1>You hit a server error</h1>
            <p>An unexpected error occurred while processing your request.</p>
            <pre>${error.message}</pre>
          </body>
          </html>
        `);
            }
            console.log(
                '🔴 [Layer 1: GlobalErrorHandler] Request END (error):',
                req.method,
                req.path,
            );
        }
    }

    /**
     * Logging middleware - logs request/response flow.
     * Demonstrates middleware execution order.
     * IMPORTANT: Must be async and await next() to properly chain with async middleware.
     */
    private async logNextLayer(req: Request, res: Response, next: NextFunction): Promise<void> {
        console.log('🟡 [Layer 2: LogNextLayer] Before next() -', req.method, req.path);
        await next();
        console.log('🟡 [Layer 2: LogNextLayer] After next() -', req.method, req.path);
    }

    /**
     * JSON Translator middleware - Handles JSON serialization/deserialization and route dispatch.
     *
     * Layer 3 responsibilities:
     * 1. Look up the route service from RouteBuilder
     * 2. For non-JSON POST/PUT/PATCH, pass through (non-JSON route)
     * 3. Create MethodMeta with request body
     * 4. Invoke the filter chain and controller
     * 5. Write JSON response
     * 6. On error: Map HttpError to status code, serialize ProtocolError
     *
     * This middleware is the route dispatcher - no individual Express route handlers needed.
     */
    private async jsonTranslator(req: Request, res: Response, next: NextFunction): Promise<void> {
        // Look up route service
        const service = this.routeBuilder.getRouteService(req.method, req.path);

        // If no route found, pass through (Express will return 404)
        if (!service) {
            console.log('[Layer 3: JsonTranslator] No route found:', req.method, req.path);
            await next();
            return;
        }

        // Check Content-Type for POST/PUT/PATCH
        const contentType = req.headers['content-type'] || '';
        const isJsonRequest = contentType.includes('application/json');

        if (['POST', 'PUT', 'PATCH'].includes(req.method) && !isJsonRequest) {
            console.log('[Layer 3: JsonTranslator] Non-JSON route, passing through:', req.method, req.path);
            await next();
            return;
        }

        console.log('[Layer 3: JsonTranslator] Request:', req.method, req.path);

        // Get route metadata
        const routeWithMeta = this.routeBuilder.getRouteWithMeta(req.method, req.path);
        if (!routeWithMeta) {
            await next();
            return;
        }

        const routeMeta = routeWithMeta.definition.routeMeta;

        try {
            // Create MethodMeta with Express Request/Response and request body
            const routeRequest = new RouteRequest(req, res);
            const meta = new MethodMeta(routeMeta, routeRequest, req.body);

            // Invoke filter chain and controller
            const responseWrapper = await service.invoke(meta);

            // Write JSON response
            console.log('[Layer 3: JsonTranslator] Response:', req.method, req.path);

            if (!res.headersSent) {
                res.status(200);
                res.setHeader('Content-Type', 'application/json');
                if (responseWrapper.response !== undefined) {
                    res.json(responseWrapper.response);
                } else {
                    res.end();
                }
            }
        } catch (err: unknown) {
            this.handleJsonTranslatorError(res, err);
        }
    }

    /**
     * Handle errors caught by jsonTranslator.
     * Maps HttpError subclasses to appropriate HTTP status codes and ProtocolError response.
     */
    private handleJsonTranslatorError(res: Response, error: unknown): void {
        if (res.headersSent) {
            return;
        }

        const protocolError = new ProtocolError();

        if (error instanceof HttpError) {
            protocolError.message = error.message;
            protocolError.subType = error.subType;
            protocolError.name = error.name;

            if (error instanceof HttpBadRequestError) {
                protocolError.field = error.field;
                protocolError.guiAlertMessage = error.guiMessage;
            }
            if (error instanceof HttpVendorError) {
                protocolError.waitSeconds = error.waitSeconds;
            }
            if (error instanceof HttpUserError) {
                protocolError.errorCode = error.errorCode;
            }

            res.status(error.code).json(protocolError);
        } else {
            // Unknown error - 500
            const err = toError(error);
            protocolError.message = 'Internal Server Error';
            console.error('[JsonTranslator] Unexpected error:', err);
            res.status(500).json(protocolError);
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
    start(port: number = 8080): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(
                new Error('Server not initialized. Call initialize() before start().'),
            );
        }

        this.port = port;

        // Create Express app
        this.app = express();

        // Layer 1: Global Error Handler (OUTERMOST - runs FIRST)
        // Catches all unhandled errors and returns HTML 500 page
        this.app.use(this.globalErrorHandler.bind(this));

        // Layer 2: Request/Response Logging
        this.app.use(this.logNextLayer.bind(this));

        // Parse JSON request bodies (must be before jsonTranslator)
        this.app.use(express.json());

        // Layer 3: JSON Translator - handles JSON serialization/deserialization and route dispatch
        // This is the route dispatcher - no individual Express route handlers needed
        this.app.use(this.jsonTranslator.bind(this));

        // Register routes (these become the innermost handlers)
        this.registerExpressRoutes();

        const routes = this.routeBuilder.getRoutes();

        // Start listening - wrap in Promise
        return new Promise((resolve, reject) => {
            this.server = this.app!.listen(this.port, (error?: Error) => {
                if (error) {
                    console.error(`[WebpiecesServer] Failed to start server:`, error);
                    reject(error);
                    return;
                }
                console.log(`[WebpiecesServer] Server listening on http://localhost:${this.port}`);
                console.log(`[WebpiecesServer] Registered ${routes.size} routes`);
                resolve();
            });
        });
    }

    private registerExpressRoutes(): void {
        if (!this.app) {
            throw new Error('Express app not initialized');
        }

        const routes = this.routeBuilder.getRoutes();
        const sortedFilters = this.routeBuilder.getSortedFilters();
        for (const [key, routeWithMeta] of routes.entries()) {
            const handler = this.routeBuilder.createHandler(key, routeWithMeta, sortedFilters)
            this.registerHandler(routeWithMeta.definition.routeMeta.httpMethod,
                routeWithMeta.definition.routeMeta.path,
                handler
                )
        }
    }

    registerHandler(httpMethod:string, path: string, handler: RouteHandler) {
        // Register with Express
        switch (httpMethod) {
            case 'get':
                this.app.get(path, handler);
                break;
            case 'post':
                this.app.post(path, handler);
                break;
            case 'put':
                this.app.put(path, handler);
                break;
            case 'delete':
                this.app.delete(path, handler);
                break;
            case 'patch':
                this.app.patch(path, handler);
                break;
            default:
                console.warn(`[WebpiecesServer] Unknown HTTP method: ${httpMethod}`);
        }
    }

    /**
     * Stop the HTTP server.
     */
    stop(): void {
        if (this.server) {
            this.server.close(() => {
                console.log('[WebpiecesServer] Server stopped');
            });
        }
    }
}
