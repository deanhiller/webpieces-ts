import { ContainerModule } from 'inversify';

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
  addRoute(route: RouteDefinition): void;
  addFilter(filter: FilterDefinition): void;
}

/**
 * Definition of a single route.
 */
export interface RouteDefinition {
  method: string;
  path: string;
  handler: RouteHandler;
}

/**
 * Definition of a filter with priority.
 */
export interface FilterDefinition {
  priority: number;
  filterClass: any;
  packageRegex?: RegExp;
}

/**
 * Handler function for routes.
 */
export type RouteHandler = (context: any) => Promise<any>;

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
