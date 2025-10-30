import express, { Express, Request, Response, NextFunction } from 'express';
import { Container } from 'inversify';
import { WebAppMeta, RouteDefinition, FilterDefinition, RouteContext } from '@webpieces/core-meta';
import { FilterChain, Filter, MethodMeta, jsonAction } from '@webpieces/http-filters';
import { getRoutes, RouteMetadata } from '@webpieces/http-routing';

/**
 * Route registry entry.
 */
interface RegisteredRoute extends RouteDefinition {
  routeMetadata?: RouteMetadata;
  controllerClass?: any;
}

/**
 * WebpiecesServer - Main bootstrap class for WebPieces applications.
 *
 * This class:
 * 1. Initializes the DI container from WebAppMeta.getDIModules()
 * 2. Registers routes from WebAppMeta.getRoutes()
 * 3. Creates filter chains
 * 4. Supports both HTTP server mode and testing mode (no HTTP)
 *
 * Usage for testing (no HTTP):
 * ```typescript
 * const server = new WebpiecesServer(new ProdServerMeta());
 * server.initialize();
 * const saveApi = server.createApiClient<SaveApi>(SaveApiMeta);
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
  private container: Container;
  private routes: Map<string, RegisteredRoute> = new Map();
  private filters: Filter[] = [];
  private initialized = false;
  private app?: Express;
  private server?: any;
  private port: number = 8080;

  constructor(meta: WebAppMeta) {
    this.meta = meta;
    this.container = new Container();
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
   */
  private loadDIModules(): void {
    const modules = this.meta.getDIModules();

    for (const module of modules) {
      this.container.load(module);
    }
  }

  /**
   * Register routes from WebAppMeta.
   */
  private registerRoutes(): void {
    const routeConfigs = this.meta.getRoutes();

    // Create a simple RouteBuilder implementation
    const routeBuilder = {
      addRoute: (route: RouteDefinition) => {
        const key = `${route.method}:${route.path}`;
        this.routes.set(key, route);
      },
      addFilter: (filterDef: FilterDefinition) => {
        // Resolve filter instance from DI container
        const filter = this.container.get<Filter>(filterDef.filterClass);
        this.filters.push(filter);
      },
    };

    // Configure routes
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

    // Middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Register routes
    this.registerExpressRoutes();

    // Start listening
    this.server = this.app.listen(this.port, () => {
      console.log(`[WebpiecesServer] Server listening on http://localhost:${this.port}`);
      console.log(`[WebpiecesServer] Registered ${this.routes.size} routes`);
      console.log(`[WebpiecesServer] Registered ${this.filters.length} filters`);
    });
  }

  /**
   * Register all routes with Express.
   */
  private registerExpressRoutes(): void {
    if (!this.app) {
      throw new Error('Express app not initialized');
    }

    for (const [key, route] of this.routes.entries()) {
      const method = route.method.toLowerCase();
      const path = route.path;

      console.log(`[WebpiecesServer] Registering route: ${method.toUpperCase()} ${path}`);

      // Create Express route handler
      const handler = async (req: Request, res: Response, next: NextFunction) => {
        try {
          // Create method metadata
          const meta: MethodMeta = {
            httpMethod: route.method,
            path: route.path,
            methodName: key,
            params: [req.body],
            request: {
              body: req.body,
              query: req.query,
              params: req.params,
              headers: req.headers,
            },
            metadata: new Map(),
          };

          // Create filter chain
          const filterChain = new FilterChain(this.filters);

          // Execute the filter chain
          const action = await filterChain.execute(meta, async () => {
            // Create typed route context
            const routeContext: RouteContext = {
              container: this.container,
              params: [req.body],
              request: meta.request,
            };

            // Final handler: invoke the controller method via route handler
            const result = await route.handler(routeContext);

            // Wrap result in a JSON action
            return jsonAction(result);
          });

          // Send response
          if (action.type === 'json') {
            res.json(action.data);
          } else if (action.type === 'error') {
            res.status(500).json({ error: action.data });
          }
        } catch (error: any) {
          console.error('[WebpiecesServer] Error handling request:', error);
          res.status(500).json({ error: error.message });
        }
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

    // Create method metadata
    const meta: MethodMeta = {
      httpMethod: route.httpMethod,
      path: route.path,
      methodName: route.methodName,
      params: [...args],
      request: {
        body: args[0], // Assume first arg is the request body
      },
      metadata: new Map(),
    };

    // Create filter chain
    const filterChain = new FilterChain(this.filters);

    // Execute the filter chain
    const action = await filterChain.execute(meta, async () => {
      // Create typed route context
      const routeContext: RouteContext = {
        container: this.container,
        params: meta.params,
        request: meta.request,
      };

      // Final handler: invoke the controller method via route handler
      const result = await registeredRoute.handler(routeContext);

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
   * Get the DI container (for testing).
   */
  getContainer(): Container {
    this.initialize();
    return this.container;
  }

  /**
   * Get all registered routes (for testing).
   */
  getRoutes(): Map<string, RegisteredRoute> {
    this.initialize();
    return this.routes;
  }

  /**
   * Get all registered filters (for testing).
   */
  getFilters(): Filter[] {
    this.initialize();
    return this.filters;
  }
}
