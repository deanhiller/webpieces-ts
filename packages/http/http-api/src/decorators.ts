import 'reflect-metadata';

/**
 * Metadata keys for storing API routing information.
 * These keys are used by both server-side (routing) and client-side (client generation).
 */
export const METADATA_KEYS = {
  API_INTERFACE: 'webpieces:api-interface',
  ROUTES: 'webpieces:routes',
  HTTP_METHOD: 'webpieces:http-method',
  PATH: 'webpieces:path',
};

/**
 * Route metadata stored on methods.
 * Used by both server-side routing and client-side HTTP client generation.
 */
export class RouteMetadata {
  httpMethod: string;
  path: string;
  methodName: string;
  parameterTypes?: any[];

  constructor(
    httpMethod: string,
    path: string,
    methodName: string,
    parameterTypes?: any[]
  ) {
    this.httpMethod = httpMethod;
    this.path = path;
    this.methodName = methodName;
    this.parameterTypes = parameterTypes;
  }
}

/**
 * Mark a class as an API interface.
 * Similar to Java's JAX-RS interface pattern.
 *
 * This decorator is used by:
 * - Server: RESTApiRoutes reads it to validate API interfaces
 * - Client: Client generator reads it to identify API interfaces
 *
 * Usage:
 * ```typescript
 * @ApiInterface()
 * abstract class SaveApiPrototype {
 *   @Post()
 *   @Path('/search/item')
 *   save(request: SaveRequest): Promise<SaveResponse> {
 *     throw new Error('Must be implemented');
 *   }
 * }
 * ```
 */
export function ApiInterface(): ClassDecorator {
  return (target: any) => {
    Reflect.defineMetadata(METADATA_KEYS.API_INTERFACE, true, target);

    // Initialize routes array if not exists
    if (!Reflect.hasMetadata(METADATA_KEYS.ROUTES, target)) {
      Reflect.defineMetadata(METADATA_KEYS.ROUTES, [], target);
    }
  };
}

/**
 * Internal helper to mark a method with an HTTP method.
 * Used by @Get, @Post, @Put, @Delete, @Patch decorators.
 */
function httpMethod(method: string): MethodDecorator {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    // For static methods, target is the constructor itself
    // For instance methods, target is the prototype
    const metadataTarget = typeof target === 'function' ? target : target.constructor;

    const existingMetadata = Reflect.getMetadata(METADATA_KEYS.ROUTES, metadataTarget) || [];

    // Find or create route metadata for this method
    let routeMetadata = existingMetadata.find(
      (r: RouteMetadata) => r.methodName === propertyKey
    );

    if (!routeMetadata) {
      routeMetadata = new RouteMetadata('', '', propertyKey as string);
      existingMetadata.push(routeMetadata);
    }

    routeMetadata.httpMethod = method;

    // Get parameter types
    const paramTypes = Reflect.getMetadata('design:paramtypes', target, propertyKey);
    if (paramTypes) {
      routeMetadata.parameterTypes = paramTypes;
    }

    Reflect.defineMetadata(METADATA_KEYS.ROUTES, existingMetadata, metadataTarget);
  };
}

/**
 * @Get decorator for GET requests.
 * Usage: @Get()
 */
export function Get(): MethodDecorator {
  return httpMethod('GET');
}

/**
 * @Post decorator for POST requests.
 * Usage: @Post()
 */
export function Post(): MethodDecorator {
  return httpMethod('POST');
}

/**
 * @Put decorator for PUT requests.
 * Usage: @Put()
 */
export function Put(): MethodDecorator {
  return httpMethod('PUT');
}

/**
 * @Delete decorator for DELETE requests.
 * Usage: @Delete()
 */
export function Delete(): MethodDecorator {
  return httpMethod('DELETE');
}

/**
 * @Patch decorator for PATCH requests.
 * Usage: @Patch()
 */
export function Patch(): MethodDecorator {
  return httpMethod('PATCH');
}

/**
 * @Path decorator to specify the route path.
 * Similar to JAX-RS @Path annotation.
 *
 * This decorator is used by:
 * - Server: To register routes at the specified path
 * - Client: To make HTTP requests to the specified path
 *
 * Usage:
 * ```typescript
 * @Post()
 * @Path('/search/item')
 * save(request: SaveRequest): Promise<SaveResponse> {
 *   throw new Error('Must be implemented');
 * }
 * ```
 */
export function Path(path: string): MethodDecorator {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    // For static methods, target is the constructor itself
    // For instance methods, target is the prototype
    const metadataTarget = typeof target === 'function' ? target : target.constructor;

    const existingMetadata = Reflect.getMetadata(METADATA_KEYS.ROUTES, metadataTarget) || [];

    // Find or create route metadata for this method
    let routeMetadata = existingMetadata.find(
      (r: RouteMetadata) => r.methodName === propertyKey
    );

    if (!routeMetadata) {
      routeMetadata = new RouteMetadata('', '', propertyKey as string);
      existingMetadata.push(routeMetadata);
    }

    routeMetadata.path = path;

    Reflect.defineMetadata(METADATA_KEYS.ROUTES, existingMetadata, metadataTarget);
  };
}

/**
 * Helper function to get all routes from an API interface class.
 * Used by both server-side routing and client-side client generation.
 */
export function getRoutes(apiClass: any): RouteMetadata[] {
  const routes = Reflect.getMetadata(METADATA_KEYS.ROUTES, apiClass);
  return routes || [];
}

/**
 * Helper function to check if a class is an API interface.
 * Used by both server-side routing and client-side client generation.
 */
export function isApiInterface(apiClass: any): boolean {
  return Reflect.getMetadata(METADATA_KEYS.API_INTERFACE, apiClass) === true;
}
