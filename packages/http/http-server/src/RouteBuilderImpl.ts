import { Container } from 'inversify';
import { RouteBuilder, RouteDefinition, FilterDefinition } from '@webpieces/core-meta';
import { Filter } from '@webpieces/http-filters';
import {RouteMetadata} from "@webpieces/http-api";

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
export interface RegisteredRoute<TResult = unknown> extends RouteDefinition<TResult> {
  routeMetadata?: RouteMetadata;
  controllerClass?: any;
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
  private filters: Filter[];
  private container: Container;

  /**
   * Create a new RouteBuilder.
   *
   * @param routes - Map to store registered routes (keyed by "METHOD:path")
   * @param filters - Array to store registered filters
   * @param container - DI container for resolving filter instances
   */
  constructor(
    routes: Map<string, RegisteredRoute<unknown>>,
    filters: Filter[],
    container: Container
  ) {
    this.routes = routes;
    this.filters = filters;
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
   * Filters are resolved from the DI container and added to the filter array.
   * They will be executed in priority order (higher priority first).
   *
   * @param filterDef - Filter definition with priority and filter class
   */
  addFilter(filterDef: FilterDefinition): void {
    // Resolve filter instance from DI container
    const filter = this.container.get<Filter>(filterDef.filterClass);

    // Set priority on the filter instance
    filter.priority = filterDef.priority;

    // Add to filters array (will be sorted by priority later)
    this.filters.push(filter);
  }
}
