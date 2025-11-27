# Architecture Refactoring Plan V2: HTTP/Router Separation

## Overview
Separate HTTP concerns from routing layer with clean protocol-agnostic design:
- **RequestContext** stores all request-scoped data in a map
- **RouterRequest** contains HTTP request data + convenience methods
- **MethodMeta** contains routing metadata (methodName, handler, controllerClass)
- **Filters** receive request body DTO, return response DTO (no Action wrapper)
- **Error handling** via protocol-agnostic ServerError hierarchy
- **Body deserialization** in WebpiecesServer using typescript-json-serializer

---

## Phase 1: Core Types & Error Handling

### 1.1 Create ServerError Hierarchy
**Package**: `packages/core/core-api` (NEW PACKAGE)
**File**: `packages/core/core-api/src/ServerError.ts` (NEW)

```typescript
/**
 * Base class for all server errors.
 * Protocol-agnostic - subclasses map to HTTP status codes in http-server layer.
 */
export abstract class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }

  /**
   * Get the HTTP status code for this error.
   * Subclasses can override for custom mappings.
   */
  abstract getStatusCode(): number;
}

/**
 * Endpoint not found - maps to 404.
 */
export class EndpointNotFoundError extends ServerError {
  constructor(path: string, method: string) {
    super(`Endpoint not found: ${method} ${path}`);
  }

  getStatusCode(): number {
    return 404;
  }
}

/**
 * Entity not found - maps to 404.
 */
export class EntityNotFoundError extends ServerError {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} not found: ${entityId}`);
  }

  getStatusCode(): number {
    return 404;
  }
}

/**
 * Unauthorized - maps to 401.
 */
export class UnauthorizedError extends ServerError {
  constructor(message: string = 'Unauthorized') {
    super(message);
  }

  getStatusCode(): number {
    return 401;
  }
}

/**
 * Forbidden - maps to 403.
 */
export class ForbiddenError extends ServerError {
  constructor(message: string = 'Forbidden') {
    super(message);
  }

  getStatusCode(): number {
    return 403;
  }
}

/**
 * Bad request - maps to 400.
 */
export class BadRequestError extends ServerError {
  constructor(message: string) {
    super(message);
  }

  getStatusCode(): number {
    return 400;
  }
}

/**
 * Validation failed - maps to 400.
 */
export class ValidationError extends ServerError {
  constructor(public violations: string[]) {
    super(`Validation failed: ${violations.join(', ')}`);
  }

  getStatusCode(): number {
    return 400;
  }
}

/**
 * Gateway error - maps to 502.
 */
export class GatewayError extends ServerError {
  constructor(message: string) {
    super(message);
  }

  getStatusCode(): number {
    return 502;
  }
}

/**
 * Internal server error - maps to 500.
 */
export class InternalServerError extends ServerError {
  constructor(message: string = 'Internal server error') {
    super(message);
  }

  getStatusCode(): number {
    return 500;
  }
}
```

**File**: `packages/core/core-api/src/index.ts` (NEW)
```typescript
export {
  ServerError,
  EndpointNotFoundError,
  EntityNotFoundError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  ValidationError,
  GatewayError,
  InternalServerError,
} from './ServerError';
```

**File**: `packages/core/core-api/package.json` (NEW)
```json
{
  "name": "@webpieces/core-api",
  "version": "1.0.0",
  "main": "./src/index.ts",
  "dependencies": {}
}
```

**File**: `packages/core/core-api/project.json` (NEW)
```json
{
  "name": "core-api",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "packages/core/core-api/src",
  "projectType": "library",
  "targets": {
    "build": {
      "executor": "@nx/js:tsc",
      "outputs": ["{options.outputPath}"],
      "options": {
        "outputPath": "dist/packages/core/core-api",
        "main": "packages/core/core-api/src/index.ts",
        "tsConfig": "packages/core/core-api/tsconfig.lib.json",
        "assets": ["packages/core/core-api/*.md"]
      }
    }
  },
  "tags": []
}
```

### 1.2 Create RequestContext
**File**: `packages/core/core-context/src/RequestContext.ts` (NEW)

```typescript
/**
 * RequestContext - Request-scoped context accessible via AsyncLocalStorage.
 *
 * This is stored in Context and accessible to:
 * - Controllers (via Context.get(RequestContext.KEY))
 * - Filters (via Context.get(RequestContext.KEY))
 * - Client code (via Context.get(RequestContext.KEY))
 *
 * RequestContext stores:
 * - RouterRequest (at RouterRequest.ROUTER_REQUEST_KEY)
 * - MethodMeta (at MethodMeta.METHOD_META_KEY)
 * - Custom application data (at any string key)
 */
export class RequestContext {
  static readonly KEY = 'REQUEST_CONTEXT';

  /**
   * Context map for request-scoped data.
   * Stores:
   * - RouterRequest at RouterRequest.ROUTER_REQUEST_KEY
   * - MethodMeta at MethodMeta.METHOD_META_KEY
   * - Headers at 'HEADER_<name>' keys
   * - Custom application data at any key
   */
  map: Map<string, any> = new Map();

  /**
   * Get a value from the context map.
   * Type-safe accessor.
   */
  get<T>(key: string): T | undefined {
    return this.map.get(key);
  }

  /**
   * Set a value in the context map.
   */
  set<T>(key: string, value: T): void {
    this.map.set(key, value);
  }

  /**
   * Check if a key exists in the context map.
   */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * Delete a key from the context map.
   */
  delete(key: string): boolean {
    return this.map.delete(key);
  }
}
```

### 1.3 Update Context exports
**File**: `packages/core/core-context/src/index.ts` (MODIFY)

```typescript
export { Context } from './Context';
export { RequestContext } from './RequestContext';
```

### 1.4 Create RouterRequest
**Package**: `packages/routing/routing-core` (RENAME from http-routing)
**File**: `packages/routing/routing-core/src/RouterRequest.ts` (NEW)

```typescript
/**
 * RouterRequest - Platform-independent HTTP request representation.
 * Similar to Java WebPieces RouterRequest.
 *
 * This decouples the routing layer from the HTTP layer (Express, Fastify, etc.).
 * The webserver translates platform-specific HTTP requests to this format.
 */
export class RouterRequest {
  /**
   * Key for storing RouterRequest in RequestContext.
   */
  static readonly ROUTER_REQUEST_KEY = 'ROUTER_REQUEST';

  /**
   * Original HTTP request (platform-specific, opaque).
   * Kept for reference but routing layer should not depend on this.
   */
  originalRequest?: any;

  /**
   * Relative path for routing (e.g., "/search/item").
   * Used by router to match routes.
   */
  relativePath: string;

  /**
   * Domain/hostname (e.g., "localhost", "example.com").
   */
  domain: string;

  /**
   * Port number (e.g., 8080, 443).
   */
  port: number;

  /**
   * HTTP method (e.g., "GET", "POST", "PUT", "DELETE", "PATCH").
   */
  method: string;

  /**
   * Whether request is HTTPS.
   */
  isHttps: boolean;

  /**
   * Query parameters parsed from URL.
   * Map<paramName, values[]>
   * Example: ?id=1&id=2&name=test → { id: ['1', '2'], name: ['test'] }
   */
  queryParams: Map<string, string[]>;

  /**
   * Request body (already deserialized by webserver).
   * For POST/PUT/PATCH, this is the typed DTO.
   */
  body?: any;

  /**
   * Cookies parsed from request.
   */
  cookies: Map<string, string>;

  /**
   * Preferred locales from Accept-Language header.
   */
  preferredLocales: string[];

  /**
   * Content-Type header value.
   */
  contentType?: string;

  /**
   * User-Agent header value.
   */
  userAgent?: string;

  /**
   * Referrer header value.
   */
  referrer?: string;

  constructor(data: Partial<RouterRequest>) {
    Object.assign(this, data);
  }

  /**
   * Convenience method to get header value from RequestContext.
   * Assumes this RouterRequest is stored in RequestContext.
   */
  getHeader(name: string): string | undefined {
    // Headers are stored in RequestContext at 'HEADER_<name>' keys
    const ctx = Context.get(RequestContext.KEY);
    return ctx?.get(`HEADER_${name.toLowerCase()}`);
  }

  /**
   * Convenience method to get single query param value.
   */
  getQueryParam(name: string): string | undefined {
    const values = this.queryParams.get(name);
    return values?.[0];
  }

  /**
   * Convenience method to get all query param values.
   */
  getQueryParams(name: string): string[] {
    return this.queryParams.get(name) || [];
  }

  /**
   * Convenience method to get path parameter from RequestContext.
   * Path params are stored at 'PATH_PARAM_<name>' keys.
   */
  getPathParam(name: string): string | undefined {
    const ctx = Context.get(RequestContext.KEY);
    return ctx?.get(`PATH_PARAM_${name}`);
  }

  /**
   * Convenience method to get cookie value.
   */
  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }
}
```

### 1.5 Create MethodMeta
**File**: `packages/routing/routing-core/src/MethodMeta.ts` (NEW)

```typescript
import { RouteHandler } from '@webpieces/core-meta';

/**
 * MethodMeta - Routing metadata for a controller method.
 * Stored in RequestContext at MethodMeta.METHOD_META_KEY.
 */
export class MethodMeta {
  /**
   * Key for storing MethodMeta in RequestContext.
   */
  static readonly METHOD_META_KEY = 'METHOD_META';

  /**
   * Controller class.
   */
  controllerClass: any;

  /**
   * Method name being invoked.
   */
  methodName: string;

  /**
   * Route handler for this method.
   */
  handler: RouteHandler<unknown>;

  constructor(data: Partial<MethodMeta>) {
    Object.assign(this, data);
  }
}
```

### 1.6 Update RouteHandler signature
**File**: `packages/core/core-meta/src/WebAppMeta.ts` (MODIFY)

Replace RouteHandler with:
```typescript
/**
 * Handler class for routes.
 * No longer takes RouteContext - uses AsyncLocalStorage instead.
 */
export abstract class RouteHandler<TResult = unknown> {
  /**
   * Execute the route handler.
   * @param params - Deserialized parameters (e.g., [SaveRequest])
   * @returns Promise of the controller method result
   */
  abstract execute(params: any[]): Promise<TResult>;
}
```

### 1.7 Delete RouteContext and RouteRequest
**File**: `packages/core/core-meta/src/WebAppMeta.ts` (MODIFY)

Remove these interfaces:
- `RouteContext`
- `RouteRequest`

They are replaced by `RouterRequest` and `RequestContext`.

### 1.8 Update Filter interface
**File**: `packages/http/http-filters/src/Filter.ts` (MAJOR REFACTOR)

```typescript
import { RequestContext } from '@webpieces/core-context';

/**
 * Filter interface - protocol-agnostic request/response processing.
 *
 * Filters receive the deserialized request body DTO and return the response DTO.
 * Access RouterRequest/MethodMeta via Context.get(RequestContext.KEY).
 */
export interface Filter {
  /**
   * Priority of this filter.
   * Higher numbers execute first.
   * Typical values:
   * - 140: Context setup
   * - 120: Request attributes
   * - 90: Metrics
   * - 80: Logging
   * - 60: JSON error handling
   * - 40: Transactions
   * - 0: Controller
   */
  priority: number;

  /**
   * Filter method that wraps the next filter/controller.
   *
   * @param requestBody - Deserialized request body DTO (e.g., SaveRequest)
   * @param next - NextFilter instance to invoke the next filter in the chain
   * @returns Promise of the response DTO (e.g., SaveResponse)
   */
  filter(requestBody: any, next: NextFilter): Promise<any>;
}

/**
 * Next filter class.
 * This is a class instead of a function type to make it easier to trace
 * who is calling what in the debugger/IDE.
 */
export abstract class NextFilter {
  /**
   * Execute the next filter in the chain.
   * @param requestBody - The request body DTO to pass to next filter
   * @returns Promise of the response DTO
   */
  abstract execute(requestBody: any): Promise<any>;
}
```

Remove Action interface and helper functions (jsonAction, errorAction). They are replaced by direct DTO return + ServerError exceptions.

---

## Phase 2: Webserver Layer (packages/http/http-server)

### 2.1 Install typescript-json-serializer
```bash
npm install typescript-json-serializer
```

### 2.2 Create HTTP → RouterRequest Translation
**File**: `packages/http/http-server/src/HttpTranslator.ts` (NEW)

```typescript
import { Request } from 'express';
import { RouterRequest } from '@webpieces/routing-core';

/**
 * HttpTranslator - Translates platform-specific HTTP requests to RouterRequest.
 *
 * This provides a clean separation between HTTP layer and routing layer.
 * We can swap Express for Fastify/Koa/etc by just implementing a new translator.
 */
export class HttpTranslator {
  /**
   * Translate Express Request to platform-independent RouterRequest.
   */
  static translateExpressToRouterRequest(req: Request): RouterRequest {
    return new RouterRequest({
      originalRequest: req,
      relativePath: req.path,
      domain: req.hostname,
      port: parseInt(req.get('host')?.split(':')[1] || '8080'),
      method: req.method,
      isHttps: req.protocol === 'https',
      queryParams: this.parseQueryParams(req.query),
      body: req.body, // Already parsed by express.json()
      cookies: this.parseCookies(req.cookies),
      preferredLocales: this.parseLocales(req.acceptsLanguages()),
      contentType: req.get('content-type'),
      userAgent: req.get('user-agent'),
      referrer: req.get('referer'),
    });
  }

  private static parseQueryParams(query: any): Map<string, string[]> {
    const params = new Map<string, string[]>();

    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        params.set(key, value.map(String));
      } else {
        params.set(key, [String(value)]);
      }
    }

    return params;
  }

  private static parseCookies(cookies: any): Map<string, string> {
    const cookieMap = new Map<string, string>();

    if (cookies) {
      for (const [key, value] of Object.entries(cookies)) {
        cookieMap.set(key, String(value));
      }
    }

    return cookieMap;
  }

  private static parseLocales(locales: string | string[] | false): string[] {
    if (!locales) return ['en'];
    if (typeof locales === 'string') return [locales];
    return locales;
  }
}
```

### 2.3 Create Body Deserializer
**File**: `packages/http/http-server/src/BodyDeserializer.ts` (NEW)

```typescript
import { deserialize } from 'typescript-json-serializer';
import { RouterRequest } from '@webpieces/routing-core';

/**
 * BodyDeserializer - Deserializes request body to typed DTOs.
 * Uses typescript-json-serializer for transformation.
 */
export class BodyDeserializer {
  /**
   * Deserialize request body to target type.
   *
   * @param routerRequest - The router request with body
   * @param targetType - The target DTO class (e.g., SaveRequest)
   * @returns Deserialized instance or undefined
   */
  static deserialize<T>(routerRequest: RouterRequest, targetType: new () => T): T | undefined {
    if (!routerRequest.body) {
      return undefined;
    }

    // If body is already an instance of target type, return as-is
    if (routerRequest.body instanceof targetType) {
      return routerRequest.body;
    }

    // Use typescript-json-serializer to transform JSON -> DTO
    try {
      return deserialize(routerRequest.body, targetType);
    } catch (error) {
      console.error('Failed to deserialize request body:', error);
      throw new Error(`Failed to deserialize request body to ${targetType.name}: ${error}`);
    }
  }

  /**
   * Deserialize array of parameters based on parameter types.
   *
   * @param routerRequest - The router request
   * @param parameterTypes - Array of parameter types from route metadata
   * @returns Array of deserialized parameters
   */
  static deserializeParams(routerRequest: RouterRequest, parameterTypes?: any[]): any[] {
    if (!parameterTypes || parameterTypes.length === 0) {
      return [];
    }

    // For now, assume first parameter is the request body
    // TODO: Support path params, query params, etc.
    const firstParamType = parameterTypes[0];

    if (firstParamType && routerRequest.body) {
      const deserialized = this.deserialize(routerRequest, firstParamType);
      return deserialized ? [deserialized] : [];
    }

    return [];
  }
}
```

### 2.4 Update WebpiecesServer
**File**: `packages/http/http-server/src/WebpiecesServer.ts` (MAJOR REFACTOR)

Key changes in `registerExpressRoutes()`:

```typescript
import { Context, RequestContext } from '@webpieces/core-context';
import { RouterRequest, MethodMeta } from '@webpieces/routing-core';
import { ServerError } from '@webpieces/core-api';
import { HttpTranslator } from './HttpTranslator';
import { BodyDeserializer } from './BodyDeserializer';

private registerExpressRoutes(): void {
  if (!this.app) {
    throw new Error('Express app not initialized');
  }

  for (const [key, route] of this.routes.entries()) {
    const method = route.method.toLowerCase();
    const path = route.path;

    console.log(`[WebpiecesServer] Registering route: ${method.toUpperCase()} ${path}`);

    // Create Express route handler
    const handler = async (req: Request, res: Response, next: NextFunction) => {
      try {
        // STEP 1: Translate Express Request → RouterRequest
        const routerRequest = HttpTranslator.translateExpressToRouterRequest(req);

        // STEP 2: Deserialize request body using typescript-json-serializer
        const paramTypes = route.routeMetadata?.parameterTypes;
        const deserializedParams = BodyDeserializer.deserializeParams(routerRequest, paramTypes);

        // Update routerRequest.body with deserialized object
        if (deserializedParams.length > 0) {
          routerRequest.body = deserializedParams[0];
        }

        // STEP 3: Create RequestContext
        const requestContext = new RequestContext();

        // STEP 4: Store RouterRequest in RequestContext
        requestContext.set(RouterRequest.ROUTER_REQUEST_KEY, routerRequest);

        // STEP 5: Store MethodMeta in RequestContext
        const methodMeta = new MethodMeta({
          controllerClass: route.controllerClass,
          methodName: route.routeMetadata?.methodName || key,
          handler: route.handler,
        });
        requestContext.set(MethodMeta.METHOD_META_KEY, methodMeta);

        // STEP 6: Store DI container in RequestContext
        requestContext.set('DI_CONTAINER', this.appContainer);

        // STEP 7: Copy headers into RequestContext
        routerRequest.headers?.forEach((value, key) => {
          requestContext.set(`HEADER_${key.toLowerCase()}`, value);
        });

        // STEP 8: Execute within AsyncLocalStorage context
        const responseDto = await Context.run(async () => {
          // Store RequestContext in AsyncLocalStorage
          Context.put(RequestContext.KEY, requestContext);

          // STEP 9: Create filter chain
          const filterChain = new FilterChain(this.filters);

          // STEP 10: Execute filter chain with request body
          const requestBody = deserializedParams[0];
          return await filterChain.execute(requestBody, async (body: any) => {
            // Final handler: invoke the controller method via route handler
            return await route.handler.execute([body]);
          });
        });

        // STEP 11: Send response
        res.status(200).json(responseDto);
      } catch (error: any) {
        // STEP 12: Handle errors
        this.handleError(error, res);
      }
    };

    // Register with Express
    switch (method) {
      case 'get':
        this.app.get(path, handler);
        break;
      case 'post':
        this.app.post(path, handler);
        break;
      case 'put':
        this.app.put(path, handler);
        break;
      case 'delete':
        this.app.delete(path, handler);
        break;
      case 'patch':
        this.app.patch(path, handler);
        break;
      default:
        console.warn(`[WebpiecesServer] Unknown HTTP method: ${method}`);
    }
  }
}

/**
 * Handle errors and translate to HTTP responses.
 */
private handleError(error: any, res: Response): void {
  if (error instanceof ServerError) {
    // Protocol-agnostic error → HTTP status code
    const statusCode = error.getStatusCode();
    res.status(statusCode).json({
      error: error.message,
      type: error.name,
    });
  } else {
    // Unexpected error
    console.error('[WebpiecesServer] Unexpected error:', error);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
}
```

Similar changes needed in `invokeRoute()` method for testing API client.

---

## Phase 3: Routing Layer (packages/routing/routing-core)

### 3.1 Rename package
Rename `packages/http/http-routing` → `packages/routing/routing-core`

Update all imports and package.json references.

### 3.2 Update RESTApiRoutes handler creation
**File**: `packages/routing/routing-core/src/RESTApiRoutes.ts` (MODIFY)

```typescript
import { Context, RequestContext } from '@webpieces/core-context';
import { MethodMeta } from './MethodMeta';

private createRouteHandler<TResult = unknown>(route: RouteMetadata): RouteHandler<TResult> {
  const controllerClass = this.controllerClass;

  return new class extends RouteHandler<TResult> {
    async execute(params: any[]): Promise<TResult> {
      // Get RequestContext from AsyncLocalStorage
      const requestContext = Context.get(RequestContext.KEY);

      if (!requestContext) {
        throw new Error('RequestContext not found in AsyncLocalStorage. Route handler must be called within Context.run().');
      }

      // Get DI container from RequestContext
      const container = requestContext.get('DI_CONTAINER');
      if (!container) {
        throw new Error('DI_CONTAINER not found in RequestContext');
      }

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

      // Invoke the method with deserialized parameters
      const result: TResult = await method.apply(controller, params);

      return result;
    }
  };
}
```

---

## Phase 4: Filter Updates

### 4.1 Update FilterChain
**File**: `packages/http/http-filters/src/FilterChain.ts` (MODIFY)

```typescript
import { Filter, NextFilter } from './Filter';

/**
 * FilterChain - Manages execution of filters in priority order.
 * Similar to Java servlet filter chains.
 *
 * Filters are sorted by priority (highest first) and each filter
 * calls next.execute() to invoke the next filter in the chain.
 *
 * The final "filter" in the chain is the controller method itself.
 */
export class FilterChain {
  private filters: Filter[];

  constructor(filters: Filter[]) {
    // Sort filters by priority (highest first)
    this.filters = [...filters].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Execute the filter chain.
   *
   * @param requestBody - Deserialized request body DTO
   * @param finalHandler - The controller method to execute at the end
   * @returns Promise of the response DTO
   */
  async execute(
    requestBody: any,
    finalHandler: (body: any) => Promise<any>
  ): Promise<any> {
    let index = 0;
    const filters = this.filters;

    const next: NextFilter = new class extends NextFilter {
      async execute(body: any): Promise<any> {
        if (index < filters.length) {
          const filter = filters[index++];
          return filter.filter(body, next);
        } else {
          // All filters have been executed, now execute the controller
          return finalHandler(body);
        }
      }
    };

    return next.execute(requestBody);
  }

  /**
   * Get all filters in the chain (sorted by priority).
   */
  getFilters(): Filter[] {
    return [...this.filters];
  }

  /**
   * Get the number of filters in the chain.
   */
  size(): number {
    return this.filters.length;
  }
}
```

### 4.2 Update ContextFilter
**File**: `packages/http/http-filters/src/filters/ContextFilter.ts` (MODIFY)

```typescript
import { injectable } from 'inversify';
import { Context, RequestContext } from '@webpieces/core-context';
import { RouterRequest, MethodMeta } from '@webpieces/routing-core';
import { Filter, NextFilter } from '../Filter';

/**
 * ContextFilter - Logs routing metadata from RequestContext.
 * Priority: 140 (executes first)
 *
 * RequestContext is already set up by WebpiecesServer.
 * This filter just logs for debugging.
 */
@injectable()
export class ContextFilter implements Filter {
  priority = 140;

  async filter(requestBody: any, next: NextFilter): Promise<any> {
    // Get RequestContext from AsyncLocalStorage
    const requestContext = Context.get(RequestContext.KEY);

    if (!requestContext) {
      throw new Error('RequestContext not found. ContextFilter requires WebpiecesServer to set up context.');
    }

    // Get RouterRequest and MethodMeta for logging
    const routerRequest = requestContext.get<RouterRequest>(RouterRequest.ROUTER_REQUEST_KEY);
    const methodMeta = requestContext.get<MethodMeta>(MethodMeta.METHOD_META_KEY);

    console.log(`[ContextFilter] ${routerRequest?.method} ${routerRequest?.relativePath} -> ${methodMeta?.methodName}`);

    try {
      return await next.execute(requestBody);
    } finally {
      // Clean up if needed
    }
  }
}
```

### 4.3 Update JsonFilter
**File**: `packages/http/http-filters/src/filters/JsonFilter.ts` (MAJOR REFACTOR)

```typescript
import { injectable, unmanaged } from 'inversify';
import { Filter, NextFilter } from '../Filter';
import { Context, RequestContext } from '@webpieces/core-context';
import { RouterRequest } from '@webpieces/routing-core';
import { ServerError, ValidationError } from '@webpieces/core-api';

/**
 * JsonFilter - Handles error translation and logging.
 * Priority: 60
 *
 * Responsibilities:
 * 1. Log requests/responses (if enabled)
 * 2. Execute next filter/controller
 * 3. Catch exceptions and translate to appropriate ServerError
 *
 * NOTE: Body deserialization is done by WebpiecesServer, not here!
 */
@injectable()
export class JsonFilter implements Filter {
  priority = 60;

  constructor(@unmanaged() private config: JsonFilterConfig = {}) {
    this.config = {
      loggingEnabled: false,
      ...config,
    };
  }

  async filter(requestBody: any, next: NextFilter): Promise<any> {
    // Store reporting info in context
    const reportingInfo = { startTime: Date.now() };
    Context.put('REPORTING_INFO', reportingInfo);

    try {
      if (this.config.loggingEnabled) {
        this.logRequest(requestBody);
      }

      // Execute next filter/controller
      const responseDto = await next.execute(requestBody);

      if (this.config.loggingEnabled) {
        this.logResponse(responseDto);
      }

      return responseDto;
    } catch (error) {
      // Translate error to ServerError if needed
      return this.handleError(error, reportingInfo);
    } finally {
      Context.remove('REPORTING_INFO');
    }
  }

  /**
   * Handle errors and re-throw as ServerError.
   */
  private handleError(error: any, reportingInfo: any): never {
    // If already a ServerError, just re-throw
    if (error instanceof ServerError) {
      throw error;
    }

    // Log unexpected errors
    console.error('Unexpected error in filter chain:', error);
    this.reportException(reportingInfo, 'Request failed', error);

    // Wrap in InternalServerError
    throw new InternalServerError(error.message || 'Internal server error');
  }

  /**
   * Report exception (for monitoring/metrics).
   */
  private reportException(reportingInfo: any, message: string, error: any): void {
    const requestContext = Context.get(RequestContext.KEY);
    const routerRequest = requestContext?.get<RouterRequest>(RouterRequest.ROUTER_REQUEST_KEY);
    const path = routerRequest?.relativePath || 'unknown';
    const method = routerRequest?.method || 'unknown';
    const duration = Date.now() - reportingInfo.startTime;

    console.error(`[JsonFilter] ${message}: ${method} ${path} (${duration}ms)`, error);
  }

  /**
   * Log the incoming request.
   */
  private logRequest(requestBody: any): void {
    const requestContext = Context.get(RequestContext.KEY);
    const routerRequest = requestContext?.get<RouterRequest>(RouterRequest.ROUTER_REQUEST_KEY);

    if (routerRequest) {
      console.log(`[JsonFilter] ${routerRequest.method} ${routerRequest.relativePath}`);
      if (requestBody) {
        console.log('[JsonFilter] Request body:', JSON.stringify(requestBody, null, 2));
      }
    }
  }

  /**
   * Log the outgoing response.
   */
  private logResponse(responseDto: any): void {
    console.log('[JsonFilter] Response: 200');
    if (responseDto) {
      console.log('[JsonFilter] Response body:', JSON.stringify(responseDto, null, 2));
    }
  }
}

/**
 * Configuration for JsonFilter.
 */
export interface JsonFilterConfig {
  loggingEnabled?: boolean;
}
```

---

## Phase 5: Client Updates (packages/http/http-client)

### 5.1 Update ClientFactory
**File**: `packages/http/http-client/src/ClientFactory.ts` (MODIFY)

```typescript
import { Context, RequestContext } from '@webpieces/core-context';

export function createClient<T extends object>(
  apiPrototype: Function & { prototype: T },
  config: ClientConfig
): T {
  // Validate that the API prototype is marked with @ApiInterface
  if (!isApiInterface(apiPrototype)) {
    const className = apiPrototype.name || 'Unknown';
    throw new Error(
      `Class ${className} must be decorated with @ApiInterface()`
    );
  }

  // Get all routes from the API prototype
  const routes = getRoutes(apiPrototype);

  // Create a map of method name -> route metadata for fast lookup
  const routeMap = new Map<string, RouteMetadata>();
  for (const route of routes) {
    routeMap.set(route.methodName, route);
  }

  // Use fetch implementation from config or global
  const fetchImpl = config.fetch || fetch;

  // Create a proxy that intercepts method calls and makes HTTP requests
  return new Proxy({} as T, {
    get(target, prop: string | symbol) {
      // Only handle string properties (method names)
      if (typeof prop !== 'string') {
        return undefined;
      }

      // Get the route metadata for this method
      const route = routeMap.get(prop);
      if (!route) {
        throw new Error(`No route found for method ${prop}`);
      }

      // Return a function that makes the HTTP request
      return async (...args: any[]) => {
        // Read RequestContext from AsyncLocalStorage (if present)
        const requestContext = Context.get(RequestContext.KEY);

        // Merge config headers with context headers (if any)
        const contextHeaders: Record<string, string> = {};
        if (requestContext) {
          // Copy headers from RequestContext
          requestContext.map.forEach((value, key) => {
            if (key.startsWith('HEADER_')) {
              const headerName = key.substring(7); // Remove 'HEADER_' prefix
              contextHeaders[headerName] = value;
            }
          });
        }

        const headers = {
          ...config.headers,
          ...contextHeaders,
        };

        return makeRequest(fetchImpl, config, route, args, headers);
      };
    },
  });
}

/**
 * Make an HTTP request based on route metadata and arguments.
 */
async function makeRequest(
  fetchImpl: typeof fetch,
  config: ClientConfig,
  route: RouteMetadata,
  args: any[],
  headers: Record<string, string>
): Promise<any> {
  const { httpMethod, path } = route;

  // Build the full URL
  const url = `${config.baseUrl}${path}`;

  // Build headers
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  // Build request options
  const options: RequestInit = {
    method: httpMethod,
    headers: requestHeaders,
  };

  // For POST/PUT/PATCH, include the body (first argument)
  if (['POST', 'PUT', 'PATCH'].includes(httpMethod) && args.length > 0) {
    options.body = JSON.stringify(args[0]);
  }

  // Make the HTTP request
  const response = await fetchImpl(url, options);

  // Check for HTTP errors
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HTTP ${response.status}: ${response.statusText}. ${errorText}`
    );
  }

  // Parse and return the JSON response
  return response.json();
}
```

---

## Phase 6: Controller Updates

### 6.1 Update SaveController
**File**: `apps/example-app/src/controllers/SaveController.ts` (MODIFY)

```typescript
import { provideSingleton } from '../../GuiceModuleTypes';
import { Controller } from '@webpieces/routing-core';
import { SaveApi, SaveApiPrototype } from '../apis/SaveApi';
import { SaveRequest, SaveResponse } from '../apis/SaveDtos';
import { Counter } from '../services/Counter';
import { RemoteApi } from '../apis/RemoteApi';
import { FetchValueRequest } from '../apis/RemoteDtos';
import { Context, RequestContext } from '@webpieces/core-context';
import { RouterRequest } from '@webpieces/routing-core';

@provideSingleton()
@Controller()
export class SaveController extends SaveApiPrototype implements SaveApi {
  constructor(
    private counter: Counter,
    private remoteService: RemoteApi
  ) {
    super();
  }

  override async save(request: SaveRequest): Promise<SaveResponse> {
    // Increment counter
    this.counter.inc();

    // Access RequestContext from AsyncLocalStorage
    const requestContext = Context.get(RequestContext.KEY);

    // Access RouterRequest
    const routerRequest = requestContext?.get<RouterRequest>(RouterRequest.ROUTER_REQUEST_KEY);
    const requestPath = routerRequest?.relativePath || 'unknown';

    console.log(`[SaveController] Processing request: ${requestPath}`);

    // Call remote service
    const fetchReq = new FetchValueRequest();
    fetchReq.name = request.query;
    const remoteResponse = await this.remoteService.fetchValue(fetchReq);

    // Build response
    const response = new SaveResponse();
    response.success = true;
    response.searchTime = 5;
    response.matches = [
      {
        title: request.query,
        description: remoteResponse.value,
        score: 100,
      },
    ];

    // Add metadata-based match if present
    if (request.meta?.source) {
      response.matches.push({
        title: `Source: ${request.meta.source}`,
        description: 'Extra match based on metadata',
        score: 50,
      });
    }

    return response;
  }
}
```

---

## Phase 7: Testing Updates

### 7.1 Update SaveApi.spec.ts
**File**: `apps/example-app/test/SaveApi.spec.ts` (MODIFY)

Tests should work without changes since `createApiClient()` handles RequestContext setup internally.

```typescript
it('should process save request successfully', async () => {
  // Create server (initializes DI container and routes)
  const server = new WebpiecesServer(new ProdServerMeta());
  server.initialize();

  // Create API client (uses routing layer, no HTTP)
  const saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);

  // Create request
  const request = new SaveRequest();
  request.query = 'test query';

  // Make request (this runs through full filter chain)
  const response = await saveApi.save(request);

  // Verify response
  expect(response).toBeDefined();
  expect(response.success).toBe(true);
  expect(response.searchTime).toBe(5);
  expect(response.matches).toHaveLength(1);
  expect(response.matches[0].title).toBe('test query');
  expect(response.matches[0].score).toBe(100);
});
```

---

## Phase 8: Export Updates

### 8.1 Update routing-core exports
**File**: `packages/routing/routing-core/src/index.ts` (MODIFY)

```typescript
export { RouterRequest } from './RouterRequest';
export { MethodMeta } from './MethodMeta';
export { RESTApiRoutes } from './RESTApiRoutes';
export { Controller } from './decorators';
export { getRoutes } from '@webpieces/http-api';
```

### 8.2 Update http-server exports
**File**: `packages/http/http-server/src/index.ts` (MODIFY)

```typescript
export { WebpiecesServer } from './WebpiecesServer';
export { HttpTranslator } from './HttpTranslator';
export { BodyDeserializer } from './BodyDeserializer';
```

### 8.3 Update core-context exports
Already done in Phase 1.3.

---

## Summary of Changes

### New Packages (1)
1. `packages/core/core-api` - ServerError hierarchy

### Renamed Packages (1)
1. `packages/http/http-routing` → `packages/routing/routing-core`

### New Files (~8)
1. `packages/core/core-api/src/ServerError.ts`
2. `packages/core/core-api/src/index.ts`
3. `packages/core/core-api/package.json`
4. `packages/core/core-api/project.json`
5. `packages/core/core-context/src/RequestContext.ts`
6. `packages/routing/routing-core/src/RouterRequest.ts`
7. `packages/routing/routing-core/src/MethodMeta.ts`
8. `packages/http/http-server/src/HttpTranslator.ts`
9. `packages/http/http-server/src/BodyDeserializer.ts`

### Modified Files (~12)
1. `packages/core/core-context/src/index.ts`
2. `packages/core/core-meta/src/WebAppMeta.ts`
3. `packages/http/http-filters/src/Filter.ts`
4. `packages/http/http-filters/src/FilterChain.ts`
5. `packages/http/http-filters/src/filters/ContextFilter.ts`
6. `packages/http/http-filters/src/filters/JsonFilter.ts`
7. `packages/routing/routing-core/src/RESTApiRoutes.ts`
8. `packages/routing/routing-core/src/index.ts`
9. `packages/http/http-server/src/WebpiecesServer.ts`
10. `packages/http/http-server/src/index.ts`
11. `packages/http/http-client/src/ClientFactory.ts`
12. `apps/example-app/src/controllers/SaveController.ts`
13. `package.json` (add typescript-json-serializer)
14. `tsconfig.base.json` (update paths for routing-core and core-api)

### Deleted Interfaces
- `RouteContext`
- `RouteRequest`
- `Action` and related helpers

---

## Benefits

✅ **Protocol-agnostic architecture** - ServerError hierarchy decouples from HTTP
✅ **Clean context design** - RequestContext is just a map, stores RouterRequest and MethodMeta
✅ **Simple filter API** - Filters receive/return DTOs directly, no Action wrapper
✅ **Type-safe errors** - Exception-based error handling with protocol-agnostic ServerError
✅ **AsyncLocalStorage everywhere** - Both client and server use Context.get()
✅ **Easy testing** - RequestContext can be mocked/setup in tests
✅ **Body deserialization in webserver** - Done before filters run
✅ **TypeScript json serialization** - Using typescript-json-serializer for DTOs

---

## Next Steps After Implementation

1. Add path parameter support (e.g., `/user/{id}`)
2. Add session/flash/validation scopes to RequestContext
3. Add i18n messages support
4. Add validation using class-validator in BodyDeserializer
5. Add support for multiple HTTP servers (Fastify translator)
6. Add streaming response support
7. Add WebSocket support (protocol-agnostic)
