import 'reflect-metadata';

/**
 * Metadata keys for storing routing information.
 */
export const METADATA_KEYS = {
  API_INTERFACE: 'webpieces:api-interface',
  ROUTES: 'webpieces:routes',
  HTTP_METHOD: 'webpieces:http-method',
  PATH: 'webpieces:path',
  CONTROLLER: 'webpieces:controller',
};

/**
 * Route metadata stored on methods.
 */
export interface RouteMetadata {
  httpMethod: string;
  path: string;
  methodName: string;
  parameterTypes?: any[];
}

/**
 * Mark a class as an API interface.
 * Similar to Java's JAX-RS interface pattern.
 *
 * Usage:
 * ```typescript
 * @ApiInterface()
 * class SaveApiMeta {
 *   @Post()
 *   @Path('/search/item')
 *   static save(request: SaveRequest): XPromise<SaveResponse> {}
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
 * Mark a method with an HTTP method.
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
      routeMetadata = {
        httpMethod: '',
        path: '',
        methodName: propertyKey as string,
      };
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
 * Usage:
 * ```typescript
 * @Post()
 * @Path('/search/item')
 * static save(request: SaveRequest): XPromise<SaveResponse> {}
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
      routeMetadata = {
        httpMethod: '',
        path: '',
        methodName: propertyKey as string,
      };
      existingMetadata.push(routeMetadata);
    }

    routeMetadata.path = path;

    Reflect.defineMetadata(METADATA_KEYS.ROUTES, existingMetadata, metadataTarget);
  };
}

/**
 * @Controller decorator to mark a class as a controller.
 * Usage:
 * ```typescript
 * @Controller()
 * export class SaveController implements SaveApi {
 *   // ...
 * }
 * ```
 */
export function Controller(): ClassDecorator {
  return (target: any) => {
    Reflect.defineMetadata(METADATA_KEYS.CONTROLLER, true, target);
  };
}

/**
 * Helper function to get all routes from an API interface class.
 */
export function getRoutes(apiClass: any): RouteMetadata[] {
  const routes = Reflect.getMetadata(METADATA_KEYS.ROUTES, apiClass);
  return routes || [];
}

/**
 * Helper function to check if a class is an API interface.
 */
export function isApiInterface(apiClass: any): boolean {
  return Reflect.getMetadata(METADATA_KEYS.API_INTERFACE, apiClass) === true;
}

/**
 * Helper function to check if a class is a controller.
 */
export function isController(controllerClass: any): boolean {
  return Reflect.getMetadata(METADATA_KEYS.CONTROLLER, controllerClass) === true;
}
