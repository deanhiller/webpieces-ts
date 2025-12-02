import express, {Express, NextFunction, Request, Response} from 'express';
import {Container, inject, injectable} from 'inversify';
import {buildProviderModule} from '@inversifyjs/binding-decorators';
import {RouteRequest, WebAppMeta} from '@webpieces/core-meta';
import {WpResponse, Service} from '@webpieces/http-filters';
import {provideSingleton} from '@webpieces/http-routing';
import {RouteBuilderImpl, RouteHandlerWithMeta, FilterWithMeta} from './RouteBuilderImpl';
import {FilterMatcher} from './FilterMatcher';
import {toError} from '@webpieces/core-util';
import {MethodMeta} from './MethodMeta';

/**
 * WebpiecesCoreServer - Core server implementation with DI.
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
 * and resolved by WebpiecesServer. It receives RouteBuilder via constructor injection.
 */
@provideSingleton()
@injectable()
export class WebpiecesCoreServer {
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

  constructor(
      @inject(RouteBuilderImpl) private routeBuilder: RouteBuilderImpl
  ) {
  }

  /**
   * Initialize the server (DI container, routes, filters).
   * This is called by WebpiecesServer after resolving this class from DI.
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
    next: NextFunction
  ): Promise<void> {
    console.log('🔴 [Layer 1: GlobalErrorHandler] Request START:', req.method, req.path);

    try {
      // await next() catches BOTH:
      // 1. Synchronous throws from next() itself
      // 2. Rejected promises from downstream async middleware
      await next();
      console.log('🔴 [Layer 1: GlobalErrorHandler] Request END (success):', req.method, req.path);
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
      console.log('🔴 [Layer 1: GlobalErrorHandler] Request END (error):', req.method, req.path);
    }
  }

  /**
   * Logging middleware - logs request/response flow.
   * Demonstrates middleware execution order.
   */
  private logNextLayer(req: Request, res: Response, next: NextFunction): void {
    console.log('🟡 [Layer 2: LogNextLayer] Before next() -', req.method, req.path);
    next();
    console.log('🟡 [Layer 2: LogNextLayer] After next() -', req.method, req.path);
  }

  /**
   * Start the HTTP server with Express.
   * Assumes initialize() has already been called by WebpiecesServer.
   */
  start(port: number = 8080): void {
    if (!this.initialized) {
      throw new Error('Server not initialized. Call initialize() before start().');
    }

    this.port = port;

    // Create Express app
    this.app = express();

    // Parse JSON request bodies
    this.app.use(express.json());

    // Layer 1: Global Error Handler (OUTERMOST - runs FIRST)
    // Catches all unhandled errors and returns HTML 500 page
    this.app.use(this.globalErrorHandler.bind(this));

    // Layer 2: Request/Response Logging
    this.app.use(this.logNextLayer.bind(this));

    // Register routes (these become the innermost handlers)
    this.registerExpressRoutes();

    const routes = this.routeBuilder.getRoutes();

    // Start listening
    this.server = this.app.listen(this.port, () => {
      console.log(`[WebpiecesServer] Server listening on http://localhost:${this.port}`);
      console.log(`[WebpiecesServer] Registered ${routes.size} routes`);
    });
  }

  /**
   * Register all routes with Express.
   */
  private registerExpressRoutes(): void {
    if (!this.app) {
      throw new Error('Express app not initialized');
    }

    const routes = this.routeBuilder.getRoutes();
    const sortedFilters = this.routeBuilder.getSortedFilters();
    for (const [key, routeWithMeta] of routes.entries()) {
      this.setupRoute(key, routeWithMeta, sortedFilters);
    }
  }

  /**
   * Setup a single route with Express.
   * Finds matching filters, creates handler, and registers with Express.
   *
   * @param key - Route key (method:path)
   * @param routeWithMeta - The route handler paired with its definition
   * @param filtersWithMeta - All filters with their definitions
   */
  private setupRoute(key: string, routeWithMeta: RouteHandlerWithMeta, filtersWithMeta: Array<FilterWithMeta>): void {
    if (!this.app) {
      throw new Error('Express app not initialized');
    }

    const route = routeWithMeta.definition;
    const routeMeta = route.routeMeta;
    const method = routeMeta.httpMethod.toLowerCase();
    const path = routeMeta.path;

    console.log(`[WebpiecesServer] Registering route: ${method.toUpperCase()} ${path}`);

    // Find matching filters for this route - FilterMatcher returns Filter[] not FilterWithMeta[]
    // So we need to convert our FilterWithMeta[] to what FilterMatcher expects
    const filterDefinitions = filtersWithMeta.map(fwm => {
      // Set the filter instance on the definition for FilterMatcher
      const def = fwm.definition;
      def.filter = fwm.filter;
      return def;
    });

    const matchingFilters = FilterMatcher.findMatchingFilters(
      route.controllerFilepath,
      filterDefinitions
    );

    // Create service that wraps the controller execution
    const controllerService: Service<MethodMeta, WpResponse> = {
      invoke: async (meta: MethodMeta): Promise<WpResponse> => {
        // Invoke the controller method via route handler
        const result = await routeWithMeta.handler.execute(meta);
        const responseWrapper = new WpResponse(result);
        return responseWrapper;
      }
    };

    // Chain filters with the controller service (reverse order for correct execution)
    // IMPORTANT: MUST USE Filter.chain(filter) and Filter.chainService(svc);
    let filterChain = matchingFilters[matchingFilters.length - 1];
    for (let i = matchingFilters.length - 2; i >= 0; i--) {
      filterChain = filterChain.chain(matchingFilters[i]);
    }
    const svc = filterChain.chainService(controllerService);

    // Create Express route handler - delegates to filter chain
    const handler = async (req: Request, res: Response, next: NextFunction) => {
      // Create RouteRequest with Express Request/Response
      const routeRequest = new RouteRequest(req, res);

      // Create MethodMeta with route info and Express Request/Response
      const meta = new MethodMeta(
        routeMeta,
        routeRequest
      );

      // Response is written by JsonFilter - we just await completion
      await svc.invoke(meta);
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
}
