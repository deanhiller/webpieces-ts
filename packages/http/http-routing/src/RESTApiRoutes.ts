import { Routes, RouteBuilder } from '@webpieces/core-meta';
import { getRoutes, isApiInterface, RouteMetadata } from './decorators';

/**
 * RESTApiRoutes - Automatically wire API interfaces to controllers.
 * Similar to Java WebPieces RESTApiRoutes.
 *
 * This class uses reflection (reflect-metadata) to read decorators from
 * an API interface class and automatically register routes that dispatch
 * to the corresponding controller methods.
 *
 * Usage:
 * ```typescript
 * // In your ServerMeta:
 * getRoutes(): Routes[] {
 *   return [
 *     new RESTApiRoutes(SaveApiMeta, SaveController),
 *     // ... more routes
 *   ];
 * }
 * ```
 *
 * The API interface and controller must follow this pattern:
 * - API interface class has @ApiInterface() decorator
 * - Methods have @Post()/@Get()/etc and @Path() decorators
 * - Controller class implements the same interface
 * - Controller class has @Controller() decorator
 */
export class RESTApiRoutes<T> implements Routes {
  private apiMetaClass: any;
  private controllerClass: any;

  /**
   * Create a new RESTApiRoutes.
   *
   * @param apiMetaClass - The API interface class with decorators (e.g., SaveApiMeta)
   * @param controllerClass - The controller class that implements the API (e.g., SaveController)
   */
  constructor(apiMetaClass: T, controllerClass: T) {
    this.apiMetaClass = apiMetaClass;
    this.controllerClass = controllerClass;

    // Validate that apiMetaClass is marked as @ApiInterface
    if (!isApiInterface(apiMetaClass)) {
      throw new Error(
        `Class ${apiMetaClass.name} must be decorated with @ApiInterface()`
      );
    }

    // Validate that controllerClass implements the methods from apiMetaClass
    this.validateControllerImplementsApi();
  }

  /**
   * Validate that the controller implements all methods from the API interface.
   */
  private validateControllerImplementsApi(): void {
    const routes = getRoutes(this.apiMetaClass);

    for (const route of routes) {
      const controllerPrototype = this.controllerClass.prototype;

      if (typeof controllerPrototype[route.methodName] !== 'function') {
        throw new Error(
          `Controller ${this.controllerClass.name} must implement method ${route.methodName} from API ${this.apiMetaClass.name}`
        );
      }
    }
  }

  /**
   * Configure routes by reading metadata from the API interface.
   */
  configure(routeBuilder: RouteBuilder): void {
    const routes = getRoutes(this.apiMetaClass);

    for (const route of routes) {
      this.registerRoute(routeBuilder, route);
    }
  }

  /**
   * Register a single route with the route builder.
   */
  private registerRoute(routeBuilder: RouteBuilder, route: RouteMetadata): void {
    if (!route.httpMethod || !route.path) {
      throw new Error(
        `Method ${route.methodName} in ${this.apiMetaClass.name} must have both @HttpMethod and @Path decorators`
      );
    }

    routeBuilder.addRoute({
      method: route.httpMethod,
      path: route.path,
      handler: async (context: any) => {
        // The handler will be invoked by the WebpiecesServer
        // context will contain:
        // - container: DI container to resolve controller
        // - request: incoming request data
        // - params: extracted parameters

        const { container, params } = context;

        // Resolve controller instance from DI container
        const controller = container.get(this.controllerClass);

        // Invoke the controller method
        const method = controller[route.methodName];
        if (typeof method !== 'function') {
          throw new Error(
            `Method ${route.methodName} not found on controller ${this.controllerClass.name}`
          );
        }

        // Call the method with parameters
        const result = await method.apply(controller, params);

        return result;
      },
    });
  }

  /**
   * Get the API interface class.
   */
  getApiClass(): any {
    return this.apiMetaClass;
  }

  /**
   * Get the controller class.
   */
  getControllerClass(): any {
    return this.controllerClass;
  }
}
