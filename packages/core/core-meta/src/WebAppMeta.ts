import { ContainerModule, Container } from 'inversify';

/**
 * Represents a route configuration that can be registered with the router.
 * Similar to Java WebPieces Routes interface.
 */
export interface Routes {
  /**
   * Configure routes using the provided RouteBuilder.
   */
  configure(routeBuilder: RouteBuilder): void;
}

/**
 * Builder for registering routes.
 * Will be implemented in http-routing package.
 */
export interface RouteBuilder {
  addRoute<TResult = unknown>(route: RouteDefinition<TResult>): void;
  addFilter(filter: FilterDefinition): void;
}

/**
 * Definition of a single route.
 *
 * Generic type parameter TResult represents the return type of the route handler.
 * This provides type safety for the entire request/response cycle.
 */
export class RouteDefinition<TResult = unknown> {
  method: string;
  path: string;
  handler: RouteHandler<TResult>;
  controllerFilepath?: string;

  constructor(
    method: string,
    path: string,
    handler: RouteHandler<TResult>,
    controllerFilepath?: string
  ) {
    this.method = method;
    this.path = path;
    this.handler = handler;
    this.controllerFilepath = controllerFilepath;
  }
}

/**
 * Definition of a filter with priority.
 *
 * Use filepathPattern to scope filters to specific controllers:
 *   - 'src/controllers/admin/**' + '/*.ts' - All admin controllers
 *   - '**' + '/admin/**' - Any file in admin directories
 *   - '**' + '/UserController.ts' - Specific controller file
 *
 * If filepathPattern is not specified, the filter matches all controllers.
 */
export class FilterDefinition {
  priority: number;
  filterClass: any;

  /**
   * Glob pattern to match controller file paths.
   * If not specified, defaults to matching all controllers.
   */
  filepathPattern: string;

  constructor(
    priority: number,
    filterClass: any,
    filepathPattern: string,
  ) {
    this.priority = priority;
    this.filterClass = filterClass;
    this.filepathPattern = filepathPattern;
  }
}

/**
 * Request data passed to route handlers.
 */
export class RouteRequest {
  body?: any;
  query?: Record<string, any>;
  params?: Record<string, any>;
  headers?: Record<string, any>;

  constructor(
    body?: any,
    query?: Record<string, any>,
    params?: Record<string, any>,
    headers?: Record<string, any>
  ) {
    this.body = body;
    this.query = query;
    this.params = params;
    this.headers = headers;
  }
}

/**
 * Context passed to route handlers.
 * Contains DI container, request data, and extracted parameters.
 */
export class RouteContext {
  /** DI container for resolving dependencies */
  container: Container;
  /** Extracted parameters (e.g., from request body, path params) */
  params: any[];
  /** Original request data */
  request?: RouteRequest;

  constructor(
    container: Container,
    params: any[],
    request?: RouteRequest
  ) {
    this.container = container;
    this.params = params;
    this.request = request;
  }
}

/**
 * Handler class for routes.
 * Takes a RouteContext and returns the controller method result.
 *
 * Generic type parameter TResult represents the return type of the controller method.
 * Example: RouteHandler<SaveResponse> for a method that returns Promise<SaveResponse>
 *
 * Using unknown as default instead of any forces type safety - consumers must
 * handle the result appropriately rather than assuming any type.
 *
 * This is a class instead of a function type to make it easier to trace
 * who is calling what in the debugger/IDE.
 */
export abstract class RouteHandler<TResult = unknown> {
  /**
   * Execute the route handler.
   * @param context - The route context containing DI container, params, and request
   * @returns Promise of the controller method result
   */
  abstract execute(context: RouteContext): Promise<TResult>;
}

/**
 * Main application metadata interface.
 * Similar to Java WebPieces WebAppMeta.
 *
 * This is the entry point that WebpiecesServer calls to configure your application.
 */
export interface WebAppMeta {
  /**
   * Returns the list of Inversify container modules for dependency injection.
   * Similar to getGuiceModules() in Java.
   */
  getDIModules(): ContainerModule[];

  /**
   * Returns the list of route configurations.
   * Similar to getRouteModules() in Java.
   */
  getRoutes(): Routes[];
}
