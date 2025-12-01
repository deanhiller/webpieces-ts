import express, { Express, Request, Response, NextFunction } from 'express';
import { Container } from 'inversify';
import { buildProviderModule } from '@inversifyjs/binding-decorators';
import { WebAppMeta, RouteContext, RouteRequest, FilterDefinition } from '@webpieces/core-meta';
import { FilterChain, Filter, MethodMeta, jsonAction } from '@webpieces/http-filters';
import { getRoutes, RouteMetadata } from '@webpieces/http-routing';
import { RouteBuilderImpl, RegisteredRoute } from './RouteBuilderImpl';
import { FilterMatcher } from './FilterMatcher';
import { toError } from '@webpieces/core-util';

/**
 * WebpiecesServer - Main bootstrap class for WebPieces applications.
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
 * Usage for testing (no HTTP):
 * ```typescript
 * const server = new WebpiecesServer(new ProdServerMeta());
 * server.initialize();
 * const saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
 * const response = await saveApi.save(request);
 * ```
 *
 * Usage for production (HTTP server):
 * ```typescript
 * const server = new WebpiecesServer(new ProdServerMeta());
 * server.start(); // Starts Express server
 * ```
 */
export class WebpiecesServer {
  private meta: WebAppMeta;

  /**
   * WebPieces container: Core WebPieces framework bindings.
   * This includes framework-level services like filters, routing infrastructure,
   * logging, metrics, etc. Similar to Java WebPieces platform container.
   */
  private webpiecesContainer: Container;

  /**
   * Application container: User's application bindings.
   * This is a child container of webpiecesContainer, so it can access
   * framework bindings while keeping app bindings separate.
   */
  private appContainer: Container;

  /**
   * Routes registry: Maps "METHOD:path" -> RegisteredRoute
   * Example: "POST:/search/item" -> { method: "POST", path: "/search/item", handler: ... }
   *
   * We use unknown instead of any for type safety - each route has its own return type,
   * but we can't have different generic types in the same Map.
   */
  private routes: Map<string, RegisteredRoute<unknown>> = new Map();

  /**
   * Registered filters with their definitions.
   * Used by FilterMatcher to match filters to routes based on filepath patterns.
   */
  private filterRegistry: Array<{ filter: Filter; definition: FilterDefinition }> = [];

  private initialized = false;
  private app?: Express;
  private server?: any;
  private port: number = 8080;

  constructor(meta: WebAppMeta) {
    this.meta = meta;

    // Create WebPieces container for framework-level bindings
    this.webpiecesContainer = new Container();

    // Create application container as a child of WebPieces container
    // This allows app container to access framework bindings
    this.appContainer = new Container({ parent: this.webpiecesContainer });
  }

  /**
   * Initialize the server (DI container, routes, filters).
   * This is called automatically by start() or can be called manually for testing.
   */
  initialize(): void {
    if (this.initialized) {
      return;
    }

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

    // Create explicit RouteBuilder implementation
    // Filters are resolved from appContainer (which has access to platformContainer too)
    const routeBuilder = new RouteBuilderImpl(
      this.routes,
      this.filterRegistry,
      this.appContainer
    );

    // Configure routes using the explicit RouteBuilder
    for (const routeConfig of routeConfigs) {
      routeConfig.configure(routeBuilder);
    }
  }

  /**
   * Start the HTTP server with Express.
   */
  start(port: number = 8080): void {
    this.port = port;
    this.initialize();

    // Create Express app
    this.app = express();

    // Layer 1: Global Error Handler (OUTERMOST - runs FIRST)
    // Wraps all subsequent middleware with try-catch
    // IMPORTANT: Use async/await to catch BOTH synchronous throws AND async rejections
    this.app.use(async (req: Request, res: Response, next: NextFunction) => {
      console.log('🔴 [Layer 1: GlobalErrorHandler] Request START:', req.method, req.path);

      try {
        // await next() catches BOTH:
        // 1. Synchronous throws from next() itself
        // 2. Rejected promises from downstream async middleware
        await next();
        console.log('🔴 [Layer 1: GlobalErrorHandler] Request END (success):', req.method, req.path);
      } catch (err: any) {
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
        console.log('🔴 [Layer 1: GlobalErrorHandler] Request END (error):', req.method, req.path);
      }
    });

    // Layer 2: Log Next Layer (runs SECOND)
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log('🟡 [Layer 2: LogNextLayer] Before next() -', req.method, req.path);
      next();
      console.log('🟡 [Layer 2: LogNextLayer] After next() -', req.method, req.path);
    });

    // Layer 3+: Standard Express middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Register routes (these become the innermost handlers)
    this.registerExpressRoutes();

    // Start listening
    this.server = this.app.listen(this.port, () => {
      console.log(`[WebpiecesServer] Server listening on http://localhost:${this.port}`);
      console.log(`[WebpiecesServer] Registered ${this.routes.size} routes`);
      console.log(`[WebpiecesServer] Registered ${this.filterRegistry.length} filters`);
    });
  }

  /**
   * Handle an incoming HTTP request through the filter chain and controller.
   * This is the main request processing logic.
   *
   * NO try-catch here - errors are handled by:
   * 1. JsonFilter - catches and returns JSON error responses
   * 2. GlobalErrorHandler middleware - catches any unhandled errors and returns HTML 500
   *
   * @param req - Express request
   * @param res - Express response
   * @param route - The registered route to execute
   * @param matchingFilters - Filters that apply to this route
   * @param key - Route key (method:path)
   */
  private async handleRequest(
    req: Request,
    res: Response,
    route: RegisteredRoute<unknown>,
    matchingFilters: Filter[],
    key: string
  ): Promise<void> {
    // Create method metadata
    const meta = new MethodMeta(
      route.method,
      route.path,
      key,
      [req.body],
      new RouteRequest(req.body, req.query, req.params, req.headers),
      undefined,
      new Map()
    );

    // Create filter chain with matched filters
    const filterChain = new FilterChain(matchingFilters);

    // Execute the filter chain
    // Errors thrown here are caught by JsonFilter or bubble to GlobalErrorHandler
    const action = await filterChain.execute(meta, async () => {
      // Create typed route context
      // Use appContainer which has access to both app and framework bindings
      const routeContext = new RouteContext(
        this.appContainer,
        [req.body],
        meta.request
      );

      // Final handler: invoke the controller method via route handler
      const result = await route.handler.execute(routeContext);

      // Wrap result in a JSON action
      return jsonAction(result);
    });

    // Send response
    if (action.type === 'json') {
      res.json(action.data);
    } else if (action.type === 'error') {
      res.status(500).json({ error: action.data });
    }
  }

  /**
   * Register all routes with Express.
   */
  private registerExpressRoutes(): void {
    if (!this.app) {
      throw new Error('Express app not initialized');
    }

    for (const [key, route] of this.routes.entries()) {
      this.setupRoute(key, route);
    }
  }

  /**
   * Setup a single route with Express.
   * Finds matching filters, creates handler, and registers with Express.
   *
   * @param key - Route key (method:path)
   * @param route - The registered route definition
   */
  private setupRoute(key: string, route: RegisteredRoute<unknown>): void {
    if (!this.app) {
      throw new Error('Express app not initialized');
    }

    const method = route.method.toLowerCase();
    const path = route.path;

    console.log(`[WebpiecesServer] Registering route: ${method.toUpperCase()} ${path}`);

    // Find matching filters for this route
    const matchingFilters = FilterMatcher.findMatchingFilters(
      route.controllerFilepath,
      this.filterRegistry
    );

    // Create Express route handler - delegates to handleRequest
    const handler = async (req: Request, res: Response, next: NextFunction) => {
      await this.handleRequest(req, res, route, matchingFilters, key);
    };

    // Register with Express
    switch (method) {
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
        console.warn(`[WebpiecesServer] Unknown HTTP method: ${method}`);
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

  /**
   * Create an API client proxy for testing (no HTTP).
   *
   * This creates a proxy object that implements the API interface
   * and routes method calls through the full filter chain to the controller.
   *
   * @param apiMetaClass - The API interface class with decorators
   * @returns Proxy object implementing the API interface
   */
  createApiClient<T>(apiMetaClass: any): T {
    this.initialize();

    // Get routes from the API metadata
    const routes = getRoutes(apiMetaClass);

    // Create a proxy object
    const proxy: any = {};

    for (const route of routes) {
      const methodName = route.methodName;

      // Create a function that routes through the filter chain
      proxy[methodName] = async (...args: any[]) => {
        return this.invokeRoute(route, args);
      };
    }

    return proxy as T;
  }

  /**
   * Invoke a route through the filter chain.
   */
  private async invokeRoute(route: RouteMetadata, args: any[]): Promise<any> {
    // Find the registered route
    const key = `${route.httpMethod}:${route.path}`;
    const registeredRoute = this.routes.get(key);

    if (!registeredRoute) {
      throw new Error(`Route not found: ${key}`);
    }

    // Find matching filters for this route
    const matchingFilters = FilterMatcher.findMatchingFilters(
      registeredRoute.controllerFilepath,
      this.filterRegistry
    );

    // Create method metadata
    const meta = new MethodMeta(
      route.httpMethod,
      route.path,
      route.methodName,
      [...args],
      new RouteRequest(args[0]), // Assume first arg is the request body
      undefined,
      new Map()
    );

    // Create filter chain with matched filters
    const filterChain = new FilterChain(matchingFilters);

    // Execute the filter chain
    const action = await filterChain.execute(meta, async () => {
      // Create typed route context
      // Use appContainer which has access to both app and framework bindings
      const routeContext = new RouteContext(
        this.appContainer,
        meta.params,
        meta.request
      );

      // Final handler: invoke the controller method via route handler
      const result = await registeredRoute.handler.execute(routeContext);

      // Wrap result in a JSON action
      return jsonAction(result);
    });

    // Return the data from the action
    if (action.type === 'error') {
      throw new Error(JSON.stringify(action.data));
    }

    return action.data;
  }

  /**
   * Get the application DI container (for testing).
   * Returns appContainer which has access to both app and framework bindings.
   */
  getContainer(): Container {
    this.initialize();
    return this.appContainer;
  }

  /**
   * Get the WebPieces framework container (for advanced testing/debugging).
   */
  getWebpiecesContainer(): Container {
    this.initialize();
    return this.webpiecesContainer;
  }


}
