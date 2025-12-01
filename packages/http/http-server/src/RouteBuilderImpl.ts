import { Container } from 'inversify';
import { RouteBuilder, RouteDefinition, FilterDefinition, RouteHandler } from '@webpieces/core-meta';
import { Filter } from '@webpieces/http-filters';
import { RouteMetadata } from '@webpieces/http-api';

/**
 * Registered route entry in the route registry.
 *
 * We use unknown instead of any for better type safety:
 * - unknown forces type checking at usage points
 * - any allows unsafe operations without checks
 *
 * Each route has its own TResult type, but we can't store different
 * generic types in the same Map, so we use unknown as a type-safe escape hatch.
 */
export class RegisteredRoute<TResult = unknown> extends RouteDefinition<TResult> {
  routeMetadata?: RouteMetadata;
  controllerClass?: any;

  constructor(
    method: string,
    path: string,
    handler: RouteHandler<TResult>,
    controllerFilepath?: string,
    routeMetadata?: RouteMetadata,
    controllerClass?: any
  ) {
    super(method, path, handler, controllerFilepath);
    this.routeMetadata = routeMetadata;
    this.controllerClass = controllerClass;
  }
}

/**
 * RouteBuilderImpl - Concrete implementation of RouteBuilder interface.
 *
 * Similar to Java WebPieces RouteBuilder, this class is responsible for:
 * 1. Registering routes with their handlers
 * 2. Registering filters with priority
 *
 * This class is explicit (not anonymous) to:
 * - Improve traceability and debugging
 * - Make the code easier to understand
 * - Enable better IDE navigation (Cmd+Click on addRoute works!)
 */
export class RouteBuilderImpl implements RouteBuilder {
  private routes: Map<string, RegisteredRoute<unknown>>;
  private filterRegistry: Array<{ filter: Filter; definition: FilterDefinition }>;
  private container: Container;

  /**
   * Create a new RouteBuilder.
   *
   * @param routes - Map to store registered routes (keyed by "METHOD:path")
   * @param filterRegistry - Array to store registered filters with their definitions
   * @param container - DI container for resolving filter instances
   */
  constructor(
    routes: Map<string, RegisteredRoute<unknown>>,
    filterRegistry: Array<{ filter: Filter; definition: FilterDefinition }>,
    container: Container
  ) {
    this.routes = routes;
    this.filterRegistry = filterRegistry;
    this.container = container;
  }

  /**
   * Register a route with the router.
   *
   * The route is stored with a key of "METHOD:path" (e.g., "POST:/search/item").
   * The TResult generic ensures type safety for the route's return type.
   *
   * @param route - Route definition with method, path, and handler
   */
  addRoute<TResult = unknown>(route: RouteDefinition<TResult>): void {
    const key = `${route.method}:${route.path}`;

    // Store as RegisteredRoute<unknown> in the map
    // Type safety is maintained through the generic on RouteDefinition
    this.routes.set(key, route as RegisteredRoute<unknown>);
  }

  /**
   * Register a filter with the filter chain.
   *
   * Filters are resolved from the DI container and stored with their definitions.
   * The definition includes pattern information used for route-specific filtering.
   * Filters will be matched and executed in priority order (higher priority first).
   *
   * @param filterDef - Filter definition with priority, filter class, and optional filepath pattern
   */
  addFilter(filterDef: FilterDefinition): void {
    // Resolve filter instance from DI container
    const filter = this.container.get<Filter>(filterDef.filterClass);

    // Set priority on the filter instance
    filter.priority = filterDef.priority;

    // Store both filter instance and definition for pattern matching
    this.filterRegistry.push({ filter, definition: filterDef });
  }
}
