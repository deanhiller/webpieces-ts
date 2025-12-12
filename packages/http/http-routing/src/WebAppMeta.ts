import { ContainerModule } from 'inversify';
import {RouteMetadata} from "@webpieces/http-api";

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
        public controllerClass: any,
        public controllerFilepath?: string,
    ) {}
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
    filter?: any; // Filter instance (set by RouteBuilder when resolving from DI)

    /**
     * Glob pattern to match controller file paths.
     * If not specified, defaults to matching all controllers.
     */
    filepathPattern: string;

    constructor(priority: number, filterClass: any, filepathPattern: string) {
        this.priority = priority;
        this.filterClass = filterClass;
        this.filepathPattern = filepathPattern;
        this.filter = undefined; // Set later by RouteBuilder
    }
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

/**
 * DI token for WebAppMeta injection.
 */
export const WEBAPP_META_TOKEN = Symbol.for('WebAppMeta');
