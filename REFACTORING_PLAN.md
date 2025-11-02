# Architecture Refactoring Plan: HTTP/Router Separation

## Overview
Separate HTTP concerns from routing layer, introduce `RouterRequest` and `PlatformContext`, move JSON deserialization to WebpiecesServer using typescript-json-serializer, and ensure both client and server can access context via AsyncLocalStorage.

---

## Phase 1: Core Types & Context (packages/core)

### 1.1 Create PlatformContext
**File**: `packages/core/core-context/src/PlatformContext.ts` (NEW)

```typescript
/**
 * PlatformContext - Request-scoped context accessible via AsyncLocalStorage.
 *
 * This is stored in Context and accessible to:
 * - Controllers (via Context.get(PlatformContext.KEY))
 * - Filters (via Context.get(PlatformContext.KEY))
 * - Client code (via Context.get(PlatformContext.KEY))
 *
 * Similar to Java WebPieces RequestContext but simplified.
 */
export class PlatformContext {
  static readonly KEY = 'PLATFORM_CONTEXT';

  /**
   * Custom context map for request-scoped data.
   * Examples:
   * - HTTP headers
   * - objects like perhaps a recorder recoarding all request/responses in all clients and in some server filter
   */
  map: Map<string, any> = new Map();

  /**
   * Convenience method to get header value.
   */
  getHeader(name: string): string | undefined {
    return this.map.get(name.toLowerCase());
  }
  

}
```

### 1.2 Update Context.ts exports
**File**: `packages/core/core-context/src/index.ts` (MODIFY)

Add export:
```typescript
export { PlatformContext } from './PlatformContext';
```

### 1.3 Create RouterRequest
**File**: `packages/http/http-routing/src/RouterRequest.ts` (NEW)

```typescript
/**
 * RouterRequest - Platform-independent HTTP request representation.
 * Similar to Java WebPieces RouterRequest.
 *
 * This decouples the routing layer from the HTTP layer (Express, Fastify, etc.).
 * The webserver translates platform-specific HTTP requests to this format.
 */
export interface RouterRequest {
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
}
```

### 1.4 Update MethodMeta
**File**: `packages/http/http-filters/src/Filter.ts` (MODIFY)

Replace current MethodMeta with:
```typescript
/**
 * MethodMeta - Filter-level request metadata.
 *
 * This is passed to filters and contains minimal routing information.
 * Filters access PlatformContext via Context.get(PlatformContext.KEY).
 */
export interface MethodMeta {
  /**
   * Route information.
   */
  request: RouterRequest;

  /**
   * Controller class (for internal use by routing layer).
   */
  controllerClass?: any;

  /**
   * Method name being invoked.
   */
  methodName: string;

  handler: RouteHandler<unknown>;
}


```

*REMOVE RouteData and use RouterRequest*

### 1.5 Update RouteHandler signature
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

### 1.6 Delete RouteContext and RouteRequest
**File**: `packages/core/core-meta/src/WebAppMeta.ts` (MODIFY)

Remove these interfaces:
- `RouteContext`
- `RouteRequest`

They are replaced by `RouterRequest` and `PlatformContext`.

---

## Phase 2: Webserver Layer (packages/http/http-server)

### 2.1 Install typescript-json-serializer
```bash
npm install typescript-json-serializer
```

Add to `package.json` dependencies.

### 2.2 Create HTTP → RouterRequest Translation
**File**: `packages/http/http-server/src/HttpTranslator.ts` (NEW)

```typescript
import { Request } from 'express';
import { RouterRequest } from '@webpieces/core-meta';

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
    const routerRequest: RouterRequest = {
      originalRequest: req,
      relativePath: req.path,
      domain: req.hostname,
      port: parseInt(req.get('host')?.split(':')[1] || '8080'),
      method: req.method,
      isHttps: req.protocol === 'https',
      queryParams: this.parseQueryParams(req.query),
      body: req.body, // Already parsed by express.json()
      cookies: this.parseCookies(req.cookies),
      headers: this.parseHeaders(req.headers),
      preferredLocales: this.parseLocales(req.acceptsLanguages()),
      contentType: req.get('content-type'),
      userAgent: req.get('user-agent'),
      referrer: req.get('referer'),
    };

    return routerRequest;
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

  private static parseHeaders(headers: any): Map<string, string> {
    const headerMap = new Map<string, string>();

    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        headerMap.set(key.toLowerCase(), value.join(', '));
      } else {
        headerMap.set(key.toLowerCase(), String(value));
      }
    }

    return headerMap;
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
import { RouterRequest } from '@webpieces/core-meta';

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
        // Get parameter types from route metadata
        const paramTypes = route.routeMetadata?.parameterTypes;
        const deserializedParams = BodyDeserializer.deserializeParams(routerRequest, paramTypes);

        // Update routerRequest.body with deserialized object
        if (deserializedParams.length > 0) {
          routerRequest.body = deserializedParams[0];
        }

        // STEP 3: Create PlatformContext with RouterRequest
        const platformContext = new PlatformContext(routerRequest);

        // Store DI container in context for route handler
        platformContext.map.set('DI_CONTAINER', this.appContainer);

        // STEP 4: Execute within AsyncLocalStorage context
        const action = await Context.run(async () => {
          // Store PlatformContext in AsyncLocalStorage
          Context.put(PlatformContext.KEY, platformContext);

          // STEP 5: Create simplified MethodMeta
          const meta: MethodMeta = {
            route: {
              httpMethod: route.method,
              path: route.path,
              handler: route.handler,
            },
            controllerClass: route.controllerClass,
            methodName: route.routeMetadata?.methodName || key,
          };

          // STEP 6: Create filter chain
          const filterChain = new FilterChain(this.filters);

          // STEP 7: Execute filter chain
          return await filterChain.execute(meta, async () => {
            // Final handler: invoke the controller method via route handler
            const result = await route.handler.execute(deserializedParams);

            // Wrap result in a JSON action
            return jsonAction(result);
          });
        });

        // STEP 8: Send response
        if (action.type === 'json') {
          res.status(action.statusCode || 200).json(action.data);
        } else if (action.type === 'error') {
          res.status(action.statusCode || 500).json(action.data);
        }
      } catch (error: any) {
        console.error('[WebpiecesServer] Error handling request:', error);
        res.status(500).json({ error: error.message });
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
```

Similar changes needed in `invokeRoute()` method for testing API client.

### 2.5 Update RouteBuilderImpl
**File**: `packages/http/http-server/src/RouteBuilderImpl.ts` (MODIFY)

Update `RegisteredRoute` interface to store parameter types:

```typescript
export interface RegisteredRoute<TResult = unknown> extends RouteDefinition<TResult> {
  routeMetadata?: RouteMetadata;  // Already exists
  controllerClass?: any;           // Already exists
}
```

---

## Phase 3: Routing Layer (packages/http/http-routing)

### 3.1 Update RESTApiRoutes handler creation
**File**: `packages/http/http-routing/src/RESTApiRoutes.ts` (MODIFY)

Update `createRouteHandler()` method:

```typescript
private createRouteHandler<TResult = unknown>(route: RouteMetadata): RouteHandler<TResult> {
  const controllerClass = this.controllerClass;

  return new class extends RouteHandler<TResult> {
    async execute(params: any[]): Promise<TResult> {
      // Get PlatformContext from AsyncLocalStorage
      const platformCtx = Context.get(PlatformContext.KEY);

      if (!platformCtx) {
        throw new Error('PlatformContext not found in AsyncLocalStorage. Route handler must be called within Context.run().');
      }

      // Get DI container from context
      const container = platformCtx.map.get('DI_CONTAINER');
      if (!container) {
        throw new Error('DI_CONTAINER not found in PlatformContext');
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

### 4.1 Update ContextFilter
**File**: `packages/http/http-filters/src/filters/ContextFilter.ts` (MODIFY)

Simplify to just add metadata to PlatformContext:

```typescript
import { injectable } from 'inversify';
import { Context, PlatformContext } from '@webpieces/core-context';
import { Filter, MethodMeta, Action, NextFilter } from '../Filter';

/**
 * ContextFilter - Adds routing metadata to PlatformContext.
 * Priority: 140 (executes first)
 *
 * PlatformContext is already set up by WebpiecesServer.
 * This filter just adds additional routing-specific metadata.
 */
@injectable()
export class ContextFilter implements Filter {
  priority = 140;

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Get PlatformContext from AsyncLocalStorage
    const platformCtx = Context.get(PlatformContext.KEY);

    if (!platformCtx) {
      throw new Error('PlatformContext not found. ContextFilter requires WebpiecesServer to set up context.');
    }

    // Add routing metadata to context
    platformCtx.map.set('CONTROLLER_CLASS', meta.controllerClass);
    platformCtx.map.set('METHOD_NAME', meta.methodName);
    platformCtx.map.set('ROUTE_PATH', meta.route.path);
    platformCtx.map.set('ROUTE_METHOD', meta.route.httpMethod);

    try {
      return await next.execute();
    } finally {
      // Clean up routing-specific metadata
      platformCtx.map.delete('CONTROLLER_CLASS');
      platformCtx.map.delete('METHOD_NAME');
      platformCtx.map.delete('ROUTE_PATH');
      platformCtx.map.delete('ROUTE_METHOD');
    }
  }
}
```

### 4.2 Update JsonFilter
**File**: `packages/http/http-filters/src/filters/JsonFilter.ts` (MAJOR REFACTOR)

Remove body deserialization. Only handle error translation and logging:

```typescript
import { injectable, unmanaged } from 'inversify';
import { Filter, MethodMeta, Action, NextFilter, jsonAction, errorAction } from '../Filter';
import { Context, PlatformContext } from '@webpieces/core-context';

/**
 * JsonFilter - Handles JSON error translation and logging.
 * Priority: 60
 *
 * Similar to Java WebPieces JacksonCatchAllFilter.
 *
 * Responsibilities:
 * 1. Log requests/responses (if enabled)
 * 2. Execute next filter/controller
 * 3. Handle errors and translate to JSON error responses
 *
 * NOTE: Body deserialization is now done by WebpiecesServer, not here!
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

  async filter(meta: MethodMeta, next: NextFilter): Promise<Action> {
    // Store reporting info in context
    const reportingInfo = { startTime: Date.now() };
    Context.put('REPORTING_INFO', reportingInfo);

    try {
      if (this.config.loggingEnabled) {
        this.logRequest(meta);
      }

      // Execute next filter/controller
      const action = await next.execute();

      if (this.config.loggingEnabled) {
        this.logResponse(action);
      }

      // Ensure response is JSON
      if (action.type !== 'json' && action.type !== 'error') {
        return jsonAction(action.data);
      }

      return action;
    } catch (error) {
      // Translate error to JSON response
      return this.handleError(error, meta, reportingInfo);
    } finally {
      Context.remove('REPORTING_INFO');
    }
  }

  /**
   * Handle errors and translate to JSON error responses.
   */
  private handleError(error: any, meta: MethodMeta, reportingInfo: any): Action {
    if (error instanceof ValidationException) {
      return errorAction(
        {
          error: 'Validation failed',
          violations: error.violations,
        } as any,
        400
      );
    }

    if (error instanceof HttpException) {
      return errorAction(
        {
          error: error.message,
          code: error.statusCode,
        } as any,
        error.statusCode
      );
    }

    // Log unexpected errors
    console.error('Unexpected error in filter chain:', error);
    this.reportException(reportingInfo, 'Request failed', error);

    return errorAction(
      'Internal server error',
      500
    );
  }

  /**
   * Report exception (for monitoring/metrics).
   */
  private reportException(reportingInfo: any, message: string, error: any): void {
    const platformCtx = Context.get(PlatformContext.KEY);
    const path = platformCtx?.routerRequest?.relativePath || 'unknown';
    const method = platformCtx?.routerRequest?.method || 'unknown';
    const duration = Date.now() - reportingInfo.startTime;

    console.error(`[JsonFilter] ${message}: ${method} ${path} (${duration}ms)`, error);
  }

  /**
   * Log the incoming request.
   */
  private logRequest(meta: MethodMeta): void {
    const platformCtx = Context.get(PlatformContext.KEY);
    const routerReq = platformCtx?.routerRequest;

    if (routerReq) {
      console.log(`[JsonFilter] ${routerReq.method} ${routerReq.relativePath}`);
      if (routerReq.body) {
        console.log('[JsonFilter] Request body:', JSON.stringify(routerReq.body, null, 2));
      }
    }
  }

  /**
   * Log the outgoing response.
   */
  private logResponse(action: Action): void {
    console.log(`[JsonFilter] Response: ${action.statusCode || 200}`);
    if (action.data) {
      console.log('[JsonFilter] Response body:', JSON.stringify(action.data, null, 2));
    }
  }
}

/**
 * Configuration for JsonFilter.
 */
export interface JsonFilterConfig {
  loggingEnabled?: boolean;
}

/**
 * Exception thrown when validation fails.
 */
export class ValidationException extends Error {
  constructor(public violations: string[]) {
    super('Validation failed');
    this.name = 'ValidationException';
  }
}

/**
 * HTTP exception with status code.
 */
export class HttpException extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'HttpException';
  }
}
```

---

## Phase 5: Client Updates (packages/http/http-client)

### 5.1 Update ClientFactory
**File**: `packages/http/http-client/src/ClientFactory.ts` (MODIFY)

Update `createClient()` to read PlatformContext from AsyncLocalStorage:

```typescript
import { Context, PlatformContext } from '@webpieces/core-context';

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
        // Read PlatformContext from AsyncLocalStorage (if present)
        const platformCtx = Context.get(PlatformContext.KEY);

        // Merge config headers with context headers (if any)
        const contextHeaders = platformCtx?.map.get('CLIENT_HEADERS') || {};
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

Update controller to access PlatformContext:

```typescript
import { provideSingleton } from '../../GuiceModuleTypes';
import { Controller } from '@webpieces/http-routing';
import { SaveApi, SaveApiPrototype } from '../apis/SaveApi';
import { SaveRequest, SaveResponse } from '../apis/SaveDtos';
import { Counter } from '../services/Counter';
import { RemoteApi } from '../apis/RemoteApi';
import { FetchValueRequest } from '../apis/RemoteDtos';
import { Context, PlatformContext } from '@webpieces/core-context';

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

    // Access PlatformContext from AsyncLocalStorage
    const platformCtx = Context.get(PlatformContext.KEY);

    // Access router request
    const routerReq = platformCtx?.routerRequest;
    const requestPath = routerReq?.relativePath || 'unknown';

    // Access custom data from context map
    const methodName = platformCtx?.map.get('METHOD_NAME');

    console.log(`[SaveController] Processing request: ${requestPath} (method: ${methodName})`);

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

Update tests to work with PlatformContext:

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

The `createApiClient()` method in WebpiecesServer should handle setting up PlatformContext automatically.

---

## Phase 8: Export Updates

### 8.1 Update core-meta exports
**File**: `packages/core/core-meta/src/index.ts` (MODIFY)

Add export:
```typescript
export { RouterRequest } from './RouterRequest';
```

### 8.2 Update http-server exports
**File**: `packages/http/http-server/src/index.ts` (MODIFY)

Add exports:
```typescript
export { HttpTranslator } from './HttpTranslator';
export { BodyDeserializer } from './BodyDeserializer';
```

---

## Summary of Changes

### New Files (5)
1. `packages/core/core-context/src/PlatformContext.ts`
2. `packages/core/core-meta/src/RouterRequest.ts`
3. `packages/http/http-server/src/HttpTranslator.ts`
4. `packages/http/http-server/src/BodyDeserializer.ts`

### Modified Files (~15)
1. `packages/core/core-context/src/index.ts`
2. `packages/core/core-meta/src/WebAppMeta.ts` (remove RouteContext/RouteRequest, update RouteHandler)
3. `packages/core/core-meta/src/index.ts` (add RouterRequest export)
4. `packages/http/http-filters/src/Filter.ts` (update MethodMeta)
5. `packages/http/http-filters/src/filters/ContextFilter.ts`
6. `packages/http/http-filters/src/filters/JsonFilter.ts` (major refactor)
7. `packages/http/http-routing/src/RESTApiRoutes.ts` (update handler creation)
8. `packages/http/http-server/src/WebpiecesServer.ts` (major refactor)
9. `packages/http/http-server/src/RouteBuilderImpl.ts` (minor)
10. `packages/http/http-server/src/index.ts` (add exports)
11. `packages/http/http-client/src/ClientFactory.ts` (add PlatformContext support)
12. `apps/example-app/src/controllers/SaveController.ts` (use PlatformContext)
13. `apps/example-app/test/SaveApi.spec.ts` (update tests)
14. `apps/example-app/test/SaveApiClient.spec.ts` (update tests)
15. `package.json` (add typescript-json-serializer)

---

## Benefits

✅ **Clean HTTP/Router separation** - Can swap Express for Fastify/Koa/etc
✅ **typescript-json-serializer** - Proper DTO transformation with decorators
✅ **Simple controller signatures** - `save(request): Promise<response>`
✅ **AsyncLocalStorage context** - Both client and server access via `Context.get()`
✅ **PlatformContext** - Single source of truth for request-scoped data
✅ **Easy testing** - PlatformContext can be mocked/setup in tests
✅ **Filters know nothing about JSON/HTTP** - Pure cross-cutting concerns
✅ **Body deserialization in webserver** - Done before filters run
✅ **Type safety** - RouterRequest is strongly typed

---

## Next Steps After Implementation

1. Add path parameter support (e.g., `/user/{id}`)
2. Add session/flash/validation scopes to PlatformContext
3. Add i18n messages support
4. Add validation using class-validator in BodyDeserializer
5. Add support for multiple HTTP servers (Fastify translator)
6. Add streaming response support
