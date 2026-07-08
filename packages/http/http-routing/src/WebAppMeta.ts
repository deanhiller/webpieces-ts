import {RouteMetadata} from "@webpieces/core-util";

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
 * Will be implemented in http-server package.
 */
export interface RouteBuilder {
    addRoute(route: RouteDefinition): void;
    addFilter(filter: FilterDefinition): void;
}

/**
 * Definition of a single route.
 *
 * Generic type parameter TResult represents the return type of the route handler.
 * This provides type safety for the entire request/response cycle.
 */
export class RouteDefinition {
    constructor(
        public routeMeta: RouteMetadata,
        // webpieces-disable no-any-unknown -- arbitrary DI controller class used as a container token
        public controllerClass: any,
        public controllerFilepath?: string,
        // The @ApiPath prototype this route belongs to; surfaced on ApiFactory.apiClients().
        public apiClass?: unknown,
    ) {}
}

/**
 * A filter's execution tier:
 *  - 'api'     : runs for BOTH real HTTP requests AND the in-process createApiClient
 *                (business/cross-cutting filters — logging, recording, context seeding).
 *  - 'express' : runs ONLY for real HTTP requests mounted on express (transport-boundary
 *                filters that need the raw request — e.g. service auth reading the
 *                Authorization header). Skipped by the in-process client so tests don't 401.
 */
export type FilterTier = 'express' | 'api';

/**
 * Definition of a filter with priority.
 *
 * Use filepathPattern to scope filters to specific controllers:
 *   - 'src/controllers/admin/**' + '/*.ts' - All admin controllers
 *   - '**' + '/admin/**' - Any file in admin directories
 *   - '**' + '/UserController.ts' - Specific controller file
 *
 * If filepathPattern is not specified, the filter matches all controllers.
 *
 * tier defaults to 'api' so a filter runs in-process (via createApiClient) as well as over
 * HTTP. Pass 'express' for transport-boundary filters that must be skipped in-process.
 */
export class FilterDefinition {
    priority: number;
    // webpieces-disable no-any-unknown -- an arbitrary DI filter class used as a container token
    filterClass: any;
    // webpieces-disable no-any-unknown -- the resolved filter instance, of arbitrary shape
    filter?: any; // Filter instance (set by RouteBuilder when resolving from DI)

    /**
     * Glob pattern to match controller file paths.
     * If not specified, defaults to matching all controllers.
     */
    filepathPattern: string;

    /** Execution tier — see {@link FilterTier}. Defaults to 'api'. */
    tier: FilterTier;

    // webpieces-disable no-any-unknown -- filterClass param is an arbitrary DI filter class token
    constructor(priority: number, filterClass: any, filepathPattern: string, tier: FilterTier = 'api') {
        this.priority = priority;
        this.filterClass = filterClass;
        this.filepathPattern = filepathPattern;
        this.tier = tier;
        this.filter = undefined; // Set later by RouteBuilder
    }
}


// The old WebAppMeta interface + WEBAPP_META_TOKEN were removed with the WebpiecesServer/
// WebpiecesFactory flip. Apps now configure routes/filters imperatively on WebpiecesRouter
// (see WebpiecesRouter.addRoutes/addFilter) instead of implementing WebAppMeta.getDIModules/getRoutes.
