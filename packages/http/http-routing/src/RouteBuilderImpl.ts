import { Container, injectable } from 'inversify';
import { Request, Response, NextFunction } from 'express';
import { RouteBuilder, RouteDefinition, FilterDefinition } from './WebAppMeta';
import { provideSingleton } from './decorators';
import { RouteHandler } from './RouteHandler';
import { MethodMeta } from './MethodMeta';
import { WpResponse, Service } from '@webpieces/http-filters';
import { FilterMatcher, HttpFilter } from './FilterMatcher';

/**
 * Express route handler function type.
 * Used by wrapExpress to create handlers that Express can call.
 */
export type ExpressRouteHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
) => Promise<void>;

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
 * RouteHandlerImpl - Concrete implementation of RouteHandler.
 * Wraps a resolved controller and method to invoke on each request.
 */
export class RouteHandlerImpl<TResult> implements RouteHandler<TResult> {
    constructor(
        private controller: Record<string, unknown>,
        private method: (this: unknown, requestDto?: unknown) => Promise<TResult>,
    ) {}

    async execute(meta: MethodMeta): Promise<TResult> {
        // Invoke the method with requestDto from meta
        // The controller is already resolved - no DI lookup on every request!
        const result: TResult = await this.method.call(this.controller, meta.requestDto);
        return result;
    }
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
        public invokeControllerHandler: RouteHandler<unknown>,
        public definition: RouteDefinition,
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
    private routes: RouteHandlerWithMeta[] = [];
    private filterRegistry: Array<FilterWithMeta> = [];
    private container?: Container;

    /**
     * Map for O(1) route lookup by method:path.
     * Used by both addRoute() and createRouteInvoker() for fast route access.
     */
    private routeMap: Map<string, RouteHandlerWithMeta> = new Map();

    /**
     * Create route key for consistent lookup.
     * Key format: "${METHOD}:${path}" (e.g., "POST:/search/item")
     */
    private createRouteKey(method: string, path: string): string {
        return `${method.toUpperCase()}:${path}`;
    }

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
     * Uses createRouteHandlerWithMeta() to create the handler, then stores it
     * in both the routes array and the routeMap for O(1) lookup.
     *
     * @param route - Route definition with controller class and method name
     */
    addRoute(route: RouteDefinition): void {
        const routeWithMeta = this.createRouteHandlerWithMeta(route);
        this.routes.push(routeWithMeta);

        // Also add to map for O(1) lookup by method:path
        const key = this.createRouteKey(
            route.routeMeta.httpMethod,
            route.routeMeta.path
        );
        this.routeMap.set(key, routeWithMeta);
    }

    /**
     * Create RouteHandlerWithMeta from a RouteDefinition.
     *
     * Resolves controller from DI container ONCE and creates a handler that
     * invokes the controller method with the request DTO.
     *
     * This method is used by:
     * - addRoute() for production route registration
     * - createRouteInvoker() for test clients (via createApiClient)
     *
     * @param route - Route definition with controller class and method name
     * @returns RouteHandlerWithMeta containing the handler and route definition
     */
    private createRouteHandlerWithMeta<TResult = unknown>(
        route: RouteDefinition,
    ): RouteHandlerWithMeta {
        if (!this.container) {
            throw new Error('Container not set. Call setContainer() before registering routes.');
        }

        const routeMeta = route.routeMeta;

        // Resolve controller instance from DI container ONCE (not on every request!)
        const controller = this.container.get(route.controllerClass) as Record<string, unknown>;

        // Get the controller method
        const method = controller[routeMeta.methodName];
        if (typeof method !== 'function') {
            const controllerName = (route.controllerClass as { name?: string }).name || 'Unknown';
            throw new Error(
                `Method ${routeMeta.methodName} not found on controller ${controllerName}`,
            );
        }

        const handler = new RouteHandlerImpl<TResult>(
            controller,
            method as (this: unknown, requestDto?: unknown) => Promise<TResult>
        );

        // Return handler with route definition
        return new RouteHandlerWithMeta(
            handler as RouteHandler<unknown>,
            route,
        );
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
    getRoutes(): RouteHandlerWithMeta[] {
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

    /**
     * Cached filter definitions for lazy route setup.
     */
    private cachedFilterDefinitions?: FilterDefinition[];

    /**
     * Get filter definitions, computing once and caching.
     */
    private getFilterDefinitions(): FilterDefinition[] {
        if (!this.cachedFilterDefinitions) {
            const sortedFilters = this.getSortedFilters();
            this.cachedFilterDefinitions = sortedFilters.map((fwm) => {
                const def = fwm.definition;
                def.filter = fwm.filter;
                return def;
            });
        }
        return this.cachedFilterDefinitions;
    }

    /**
     * Setup a single route by creating its filter chain.
     * This is called lazily by createHandler() and getRouteService().
     *
     * Creates a Service that wraps the filter chain and controller invocation.
     * The service is DTO-only and has no Express dependency.
     *
     * @param key - Route key in format "METHOD:path"
     * @param routeWithMeta - Route handler with metadata
     * @returns The service for this route
     */
    public createRouteHandler(
        routeWithMeta: RouteHandlerWithMeta,
    ): Service<MethodMeta, WpResponse<unknown>> {
        const route = routeWithMeta.definition;
        const routeMeta = route.routeMeta;

        console.log(`[RouteBuilder] Setting up route: ${routeMeta.httpMethod} ${routeMeta.path}`);

        // Get cached filter definitions
        const filterDefinitions = this.getFilterDefinitions();

        // Find matching filters for this route
        const matchingFilters = FilterMatcher.findMatchingFilters(
            route.controllerFilepath,
            filterDefinitions,
        );

        // Create service that wraps the controller execution
        const controllerService: Service<MethodMeta, WpResponse<unknown>> = {
            invoke: async (meta: MethodMeta): Promise<WpResponse<unknown>> => {
                const result = await routeWithMeta.invokeControllerHandler.execute(meta);
                return new WpResponse(result);
            },
        };

        if (matchingFilters.length === 0) {
            throw new Error("No filters found for route. Check filter definitions as you must have at least ContextFilter");
        }

        // Chain filters with the controller service (reverse order for correct execution)
        let filterChain = matchingFilters[matchingFilters.length - 1];
        for (let i = matchingFilters.length - 2; i >= 0; i--) {
            filterChain = filterChain.chain(matchingFilters[i]);
        }

        return filterChain.chainService(controllerService);
    }

    /**
     * Create an invoker function for a route (for testing via createApiClient).
     * Uses routeMap for O(1) lookup, sets up the filter chain ONCE,
     * and returns a Service that can be called multiple times without
     * recreating the filter chain.
     *
     * This method is called by WebpiecesServer.createApiClient() during proxy setup.
     * The returned Service is stored as the proxy method and invoked on each call.
     *
     * @param method - HTTP method (GET, POST, etc.)
     * @param path - URL path
     * @returns A Service that invokes the route
     */
    createRouteInvoker(method: string, path: string): Service<MethodMeta, WpResponse<unknown>> {
        // Use routeMap for O(1) lookup (not linear search!)
        const key = this.createRouteKey(method, path);
        const routeWithMeta = this.routeMap.get(key);

        if (!routeWithMeta) {
            throw new Error(`Route not found: ${method} ${path}`);
        }

        // Setup filter chain ONCE (not on every invocation!)
        return this.createRouteHandler(routeWithMeta);
    }
}
