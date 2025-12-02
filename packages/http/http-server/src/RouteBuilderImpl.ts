import { Container, injectable } from 'inversify';
import { RouteBuilder, RouteDefinition, FilterDefinition } from '@webpieces/http-routing';
import { Filter, WpResponse } from '@webpieces/http-filters';
import { provideSingleton } from '@webpieces/http-routing';
import { RouteHandler } from './RouteHandler';
import { MethodMeta } from './MethodMeta';

/**
 * Type alias for HTTP filters that work with MethodMeta and ResponseWrapper.
 */
export type HttpFilter = Filter<MethodMeta, WpResponse<unknown>>;

/**
 * FilterWithMeta - Pairs a resolved filter instance with its definition.
 * Stores both the DI-resolved filter and the metadata needed for matching.
 */
export class FilterWithMeta {
    constructor(
        public filter: HttpFilter,
        public definition: FilterDefinition,
    ) {}
}

/**
 * RouteHandlerWithMeta - Pairs a route handler with its definition.
 * Stores both the handler (which wraps the DI-resolved controller) and the route metadata.
 *
 * We use unknown for the generic type since we store different TResult types in the same Map.
 * Type safety is maintained through the generic on RouteDefinition at registration time.
 */
export class RouteHandlerWithMeta {
    constructor(
        public handler: RouteHandler<unknown>,
        public definition: RouteDefinition<unknown>,
    ) {}
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
 *
 * DI Pattern: This class is registered in webpiecesContainer via @provideSingleton()
 * but needs appContainer to resolve filters/controllers. The container is set via
 * setContainer() after appContainer is created (late binding pattern).
 */
@provideSingleton()
@injectable()
export class RouteBuilderImpl implements RouteBuilder {
    private routes: Map<string, RouteHandlerWithMeta> = new Map();
    private filterRegistry: Array<FilterWithMeta> = [];
    private container?: Container;

    /**
     * Set the DI container used for resolving filters and controllers.
     * Called by WebpiecesCoreServer after appContainer is created.
     *
     * @param container - The application DI container (appContainer)
     */
    setContainer(container: Container): void {
        this.container = container;
    }

    /**
     * Register a route with the router.
     *
     * Resolves the controller from DI container ONCE and creates a handler that uses
     * the resolved controller instance. This is more efficient than resolving on every request.
     *
     * The route is stored with a key of "METHOD:path" (e.g., "POST:/search/item").
     *
     * @param route - Route definition with controller class and method name
     */
    addRoute<TResult = unknown>(route: RouteDefinition<TResult>): void {
        if (!this.container) {
            throw new Error('Container not set. Call setContainer() before registering routes.');
        }

        const routeMeta = route.routeMeta;

        const key = `${routeMeta.httpMethod}:${routeMeta.path}`;

        // Resolve controller instance from DI container ONCE (not on every request!)
        const controller = this.container.get(route.controllerClass);

        // Get the controller method
        const method = (controller as Record<string, unknown>)[routeMeta.methodName];
        if (typeof method !== 'function') {
            const controllerName = (route.controllerClass as { name?: string }).name || 'Unknown';
            throw new Error(
                `Method ${routeMeta.methodName} not found on controller ${controllerName}`,
            );
        }

        // Create handler that uses the resolved controller instance
        const handler = new (class extends RouteHandler<TResult> {
            async execute(meta: MethodMeta): Promise<TResult> {
                // Invoke the method with requestDto from meta
                // The controller is already resolved - no DI lookup on every request!
                // Pass requestDto as the single argument to the controller method
                const result: TResult = await method.call(controller, meta.requestDto);
                return result;
            }
        })();

        // Store handler with route definition
        const routeWithMeta = new RouteHandlerWithMeta(
            handler as RouteHandler<unknown>,
            route as RouteDefinition<unknown>,
        );

        this.routes.set(key, routeWithMeta);
    }

    /**
     * Register a filter with the filter chain.
     *
     * Resolves the filter from DI container and pairs it with the filter definition.
     * The definition includes pattern information used for route-specific filtering.
     *
     * @param filterDef - Filter definition with priority, filter class, and optional filepath pattern
     */
    addFilter(filterDef: FilterDefinition): void {
        if (!this.container) {
            throw new Error('Container not set. Call setContainer() before registering filters.');
        }

        // Resolve filter instance from DI container
        const filter = this.container.get<HttpFilter>(filterDef.filterClass);

        // Store filter with its definition
        const filterWithMeta = new FilterWithMeta(filter, filterDef);
        this.filterRegistry.push(filterWithMeta);
    }

    /**
     * Get all registered routes.
     *
     * @returns Map of routes with handlers and definitions, keyed by "METHOD:path"
     */
    getRoutes(): Map<string, RouteHandlerWithMeta> {
        return this.routes;
    }

    /**
     * Get all filters sorted by priority (highest priority first).
     *
     * @returns Array of FilterWithMeta sorted by priority
     */
    getSortedFilters(): Array<FilterWithMeta> {
        return [...this.filterRegistry].sort(
            (a, b) => b.definition.priority - a.definition.priority,
        );
    }
}
