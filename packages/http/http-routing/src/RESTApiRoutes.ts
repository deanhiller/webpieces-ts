import { Routes, RouteBuilder, RouteHandler, RouteContext, RouteDefinition } from '@webpieces/core-meta';
import { getRoutes, isApiInterface, RouteMetadata } from '@webpieces/http-api';
import { ROUTING_METADATA_KEYS } from './decorators';

/**
 * Type representing a class constructor (abstract or concrete).
 */
export type ClassType<T = any> = Function & { prototype: T };

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
 *     new RESTApiRoutes(SaveApiPrototype, SaveController),
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
 *
 * Type Parameters:
 * - TApi: The API prototype class type (abstract class with decorators)
 * - TController: The controller class type (must extend TApi)
 */
export class RESTApiRoutes<TApi = any, TController extends TApi = any> implements Routes {
  private apiMetaClass: ClassType<TApi>;
  private controllerClass: ClassType<TController>;

  /**
   * Create a new RESTApiRoutes.
   *
   * @param apiMetaClass - The API interface class with decorators (e.g., SaveApiPrototype)
   * @param controllerClass - The controller class that implements the API (e.g., SaveController)
   */
  constructor(apiMetaClass: ClassType<TApi>, controllerClass: ClassType<TController>) {
    this.apiMetaClass = apiMetaClass;
    this.controllerClass = controllerClass;

    // Validate that apiMetaClass is marked as @ApiInterface
    if (!isApiInterface(apiMetaClass)) {
      const className = (apiMetaClass as any).name || 'Unknown';
      throw new Error(
        `Class ${className} must be decorated with @ApiInterface()`
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
        const controllerName = (this.controllerClass as any).name || 'Unknown';
        const apiName = (this.apiMetaClass as any).name || 'Unknown';
        throw new Error(
          `Controller ${controllerName} must implement method ${route.methodName} from API ${apiName}`
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
      const apiName = (this.apiMetaClass as any).name || 'Unknown';
      throw new Error(
        `Method ${route.methodName} in ${apiName} must have both @HttpMethod and @Path decorators`
      );
    }

    // Extract controller filepath for filter matching
    const controllerFilepath = this.getControllerFilepath();

    // Create typed route handler
    // The handler's return type is inferred from the controller method's return type
    const routeHandler: RouteHandler<unknown> = this.createRouteHandler(route);

    routeBuilder.addRoute(
      new RouteDefinition(
        route.httpMethod,
        route.path,
        routeHandler,
        controllerFilepath
      )
    );
  }

  /**
   * Create a typed route handler for a specific route.
   *
   * The handler:
   * 1. Resolves the controller from the DI container
   * 2. Invokes the controller method with extracted parameters
   * 3. Returns the controller method result
   *
   * Type parameter TResult represents the return type of the controller method.
   * At runtime, we can't enforce this statically, but TypeScript will infer it
   * from the method signature on the API interface.
   */
  private createRouteHandler<TResult = unknown>(route: RouteMetadata): RouteHandler<TResult> {
    const controllerClass = this.controllerClass;

    return new class extends RouteHandler<TResult> {
      async execute(context: RouteContext): Promise<TResult> {
        const { container, params } = context;

        // Resolve controller instance from DI container
        const controller = container.get(controllerClass) as TController;

        // Get the controller method
        const method = (controller as any)[route.methodName];
        if (typeof method !== 'function') {
          const controllerName = (controllerClass as any).name || 'Unknown';
          throw new Error(
            `Method ${route.methodName} not found on controller ${controllerName}`
          );
        }

        // Invoke the method with parameters and return the result
        // TypeScript trusts that the method returns Promise<TResult> based on
        // the interface definition (e.g., SaveApi.save returns Promise<SaveResponse>)
        const result: TResult = await method.apply(controller, params);

        return result;
      }
    };
  }

  /**
   * Get the filepath of the controller source file.
   * Uses a heuristic based on the controller class name.
   *
   * Since TypeScript doesn't provide source file paths at runtime,
   * we use the class name to create a pattern that filters can match against.
   *
   * @returns Filepath pattern or undefined
   */
  private getControllerFilepath(): string | undefined {
    // Check for explicit @SourceFile decorator metadata
    const filepath = Reflect.getMetadata(
      ROUTING_METADATA_KEYS.SOURCE_FILEPATH,
      this.controllerClass
    );
    if (filepath) {
      return filepath;
    }

    // Fallback to class name pattern
    const className = (this.controllerClass as any).name;
    return className ? `**/${className}.ts` : undefined;
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
