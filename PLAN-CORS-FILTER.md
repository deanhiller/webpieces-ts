# Plan: CorsDevFilter for WebPieces-TS2

## Problem Statement

Angular client on `localhost:4250` cannot make requests to WebPieces server on `localhost:8250` due to CORS policy blocking cross-origin requests. The browser shows:

```
Access to fetch at 'http://localhost:8250/welcome' from origin 'http://localhost:4250'
has been blocked by CORS policy: Response to preflight request doesn't pass access
control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## Solution Overview

Create a `CorsDevFilter` in the webpieces-ts2 framework that:
1. Only enables CORS headers in development environments (not production)
2. Requires an `Environment` interface that applications must bind
3. Runs at priority 1700 (after ContextFilter at 2000, after LogApiFilter at 1800)
4. Fails fast on startup if `Environment` is not bound

## Implementation Steps

### Step 1: Create Environment Interface

**File:** `/packages/http/http-api/src/Environment.ts`

```typescript
/**
 * Environment interface that applications must implement and bind.
 * Used by CorsDevFilter to determine if CORS should be enabled.
 */
export interface Environment {
  /**
   * Returns true if running in a cloud/production environment.
   * CORS will be DISABLED when this returns true.
   * CORS will be ENABLED when this returns false (local development).
   */
  isCloud(): boolean;

  /**
   * Returns the environment name for logging purposes.
   * Examples: 'DEV_LOCAL', 'DEV_CLOUD', 'PRODUCTION', etc.
   */
  name(): string;
}

// Injection token for Environment
export const ENVIRONMENT_TOKEN = Symbol.for('Environment');
```

**Export from:** `/packages/http/http-api/src/index.ts`
- Add: `export { Environment, ENVIRONMENT_TOKEN } from './Environment';`

### Step 2: Create CorsDevFilter

**File:** `/packages/http/http-server/src/filters/CorsDevFilter.ts`

```typescript
import { injectable, inject } from 'inversify';
import { provideSingleton } from '@webpieces/http-routing';
import { Filter, Service, WpResponse } from '@webpieces/http-filters';
import { MethodMeta } from '@webpieces/http-routing';
import { Environment, ENVIRONMENT_TOKEN } from '@webpieces/http-api';

/**
 * CorsDevFilter - Adds CORS headers for development environments only.
 *
 * Priority: 1700 (runs after LogApiFilter at 1800)
 *
 * This filter:
 * - Handles OPTIONS preflight requests by returning 204 with CORS headers
 * - Adds CORS headers to all responses in non-cloud environments
 * - Does nothing in cloud/production environments
 *
 * IMPORTANT: Applications MUST bind Environment in their DI container.
 * If not bound, the server will fail to start with a clear error message.
 */
@provideSingleton()
@injectable()
export class CorsDevFilter extends Filter<MethodMeta, WpResponse<unknown>> {
  private readonly corsEnabled: boolean;
  private readonly envName: string;

  constructor(
    @inject(ENVIRONMENT_TOKEN) environment: Environment
  ) {
    super();
    this.corsEnabled = !environment.isCloud();
    this.envName = environment.name();

    if (this.corsEnabled) {
      console.log(`[CorsDevFilter] CORS enabled for environment: ${this.envName}`);
    } else {
      console.log(`[CorsDevFilter] CORS disabled for environment: ${this.envName}`);
    }
  }

  async filter(
    meta: MethodMeta,
    nextFilter: Service<MethodMeta, WpResponse<unknown>>
  ): Promise<WpResponse<unknown>> {
    // If CORS is disabled (production), just pass through
    if (!this.corsEnabled) {
      return nextFilter.invoke(meta);
    }

    // Get the origin from request headers
    const origin = this.getHeader(meta, 'origin');

    // Handle OPTIONS preflight request
    if (meta.routeMeta.httpMethod === 'OPTIONS') {
      return this.createPreflightResponse(origin);
    }

    // For regular requests, call next filter and add CORS headers to response
    const response = await nextFilter.invoke(meta);
    return this.addCorsHeaders(response, origin);
  }

  private getHeader(meta: MethodMeta, headerName: string): string | undefined {
    if (!meta.requestHeaders) return undefined;
    const values = meta.requestHeaders.get(headerName.toLowerCase());
    return values && values.length > 0 ? values[0] : undefined;
  }

  private createPreflightResponse(origin: string | undefined): WpResponse<unknown> {
    const headers = this.buildCorsHeaders(origin);
    headers.set('Content-Length', ['0']);

    return {
      statusCode: 204,
      headers: headers,
      body: undefined
    };
  }

  private addCorsHeaders(
    response: WpResponse<unknown>,
    origin: string | undefined
  ): WpResponse<unknown> {
    const corsHeaders = this.buildCorsHeaders(origin);

    // Merge CORS headers into existing response headers
    const mergedHeaders = response.headers
      ? new Map(response.headers)
      : new Map<string, string[]>();

    corsHeaders.forEach((value, key) => {
      mergedHeaders.set(key, value);
    });

    return {
      ...response,
      headers: mergedHeaders
    };
  }

  private buildCorsHeaders(origin: string | undefined): Map<string, string[]> {
    const headers = new Map<string, string[]>();

    // Allow the requesting origin (or * for development)
    headers.set('Access-Control-Allow-Origin', [origin || '*']);

    // Allow credentials (cookies, authorization headers)
    headers.set('Access-Control-Allow-Credentials', ['true']);

    // Allowed methods
    headers.set('Access-Control-Allow-Methods', [
      'GET, POST, PUT, DELETE, PATCH, OPTIONS'
    ]);

    // Allowed headers (comprehensive list for development)
    headers.set('Access-Control-Allow-Headers', [
      'Content-Type, Authorization, X-Requested-With, Accept, Accept-Language, ' +
      'Content-Language, X-Request-Id, X-Correlation-Id, X-Previous-Request-Id'
    ]);

    // Expose headers to client JavaScript
    headers.set('Access-Control-Expose-Headers', [
      'X-Request-Id, X-Correlation-Id'
    ]);

    // Cache preflight response for 1 hour
    headers.set('Access-Control-Max-Age', ['3600']);

    return headers;
  }
}
```

**Export from:** `/packages/http/http-server/src/index.ts`
- Add: `export { CorsDevFilter } from './filters/CorsDevFilter';`

### Step 3: Handle OPTIONS Routes in WebPieces

The WebPieces framework may not have routes for OPTIONS requests. We need to ensure OPTIONS requests can reach the CorsDevFilter. Check if this is handled automatically or needs special handling.

**File to check:** `/packages/http/http-server/src/ExpressWrapper.ts` or similar

If OPTIONS is not handled, the CorsDevFilter may need to be applied at the Express level before routing. In that case, create an Express middleware version:

**Alternative File:** `/packages/http/http-server/src/middleware/corsDevMiddleware.ts`

```typescript
import { RequestHandler } from 'express';
import { Environment } from '@webpieces/http-api';

/**
 * Creates Express middleware for CORS in development.
 * Use this if the filter-based approach doesn't work for OPTIONS preflight.
 */
export function createCorsDevMiddleware(environment: Environment): RequestHandler {
  const corsEnabled = !environment.isCloud();

  if (!corsEnabled) {
    // No-op middleware for production
    return (_req, _res, next) => next();
  }

  console.log(`[CorsDevMiddleware] CORS enabled for environment: ${environment.name()}`);

  return (req, res, next) => {
    const origin = req.headers.origin;

    // Set CORS headers
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Requested-With, Accept, Accept-Language, ' +
      'Content-Language, X-Request-Id, X-Correlation-Id, X-Previous-Request-Id');
    res.header('Access-Control-Expose-Headers', 'X-Request-Id, X-Correlation-Id');
    res.header('Access-Control-Max-Age', '3600');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  };
}
```

### Step 4: Update WebpiecesServerImpl to Install CORS Middleware

**File:** `/packages/http/http-server/src/WebpiecesServerImpl.ts`

Add the CORS middleware BEFORE routes are registered:

```typescript
// In the initialize or start method, after Express app is created:

// Try to get Environment - if not bound, CORS will be disabled
try {
  const environment = container.get<Environment>(ENVIRONMENT_TOKEN);
  const corsMiddleware = createCorsDevMiddleware(environment);
  this.app.use(corsMiddleware);
} catch (e) {
  console.log('[WebpiecesServer] Environment not bound - CORS middleware disabled');
}
```

### Step 5: Update Example App to Bind Environment

**File:** `/apps/example-app/src/modules/CompanyModule.ts`

```typescript
import { ContainerModule } from 'inversify';
import { Environment, ENVIRONMENT_TOKEN } from '@webpieces/http-api';

// Simple development environment implementation
class DevLocalEnvironment implements Environment {
  isCloud(): boolean {
    return false; // Development = CORS enabled
  }

  name(): string {
    return 'DEV_LOCAL';
  }
}

export const CompanyModule = new ContainerModule((options) => {
  const { bind } = options;

  // Bind Environment - REQUIRED for CorsDevFilter
  bind<Environment>(ENVIRONMENT_TOKEN).toConstantValue(new DevLocalEnvironment());

  // ... other bindings
});
```

### Step 6: Add Filter to FilterRoutes (If Using Filter Approach)

**File:** `/apps/example-app/src/routes/FilterRoutes.ts`

```typescript
import { CorsDevFilter } from '@webpieces/http-server';

export class FilterRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    routeBuilder.addFilter(new FilterDefinition(2000, ContextFilter, '*'));
    routeBuilder.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));
    routeBuilder.addFilter(new FilterDefinition(1700, CorsDevFilter, '*')); // NEW
  }
}
```

### Step 7: Test Startup Failure Without Environment Binding

Create a test that verifies the server fails to start with a clear error when Environment is not bound:

**File:** `/packages/http/http-server/src/__tests__/CorsDevFilter.test.ts`

```typescript
describe('CorsDevFilter', () => {
  it('should fail with clear error if Environment not bound', async () => {
    // Create container without Environment binding
    const container = new Container();

    await expect(async () => {
      container.get(CorsDevFilter);
    }).rejects.toThrow(/Environment/);
  });

  it('should enable CORS when isCloud() returns false', async () => {
    // ... test implementation
  });

  it('should disable CORS when isCloud() returns true', async () => {
    // ... test implementation
  });
});
```

## File Summary

### New Files to Create

| File | Description |
|------|-------------|
| `/packages/http/http-api/src/Environment.ts` | Environment interface and token |
| `/packages/http/http-server/src/filters/CorsDevFilter.ts` | CORS filter (filter approach) |
| `/packages/http/http-server/src/middleware/corsDevMiddleware.ts` | CORS middleware (Express approach) |
| `/packages/http/http-server/src/__tests__/CorsDevFilter.test.ts` | Tests |

### Files to Modify

| File | Changes |
|------|---------|
| `/packages/http/http-api/src/index.ts` | Export Environment, ENVIRONMENT_TOKEN |
| `/packages/http/http-server/src/index.ts` | Export CorsDevFilter |
| `/packages/http/http-server/src/WebpiecesServerImpl.ts` | Install CORS middleware |
| `/apps/example-app/src/modules/CompanyModule.ts` | Bind Environment |
| `/apps/example-app/src/routes/FilterRoutes.ts` | Add CorsDevFilter at 1700 |

## Priority Order Reference

After implementation, the filter priority chain will be:

```
HTTP Request
    ↓
ContextFilter (2000) - Transfer headers to RequestContext
    ↓
LogApiFilter (1800) - Log request/response
    ↓
CorsDevFilter (1700) - Add CORS headers (dev only)
    ↓
[Other App Filters]
    ↓
Controller
```

## Notes

1. **OPTIONS Preflight**: The main challenge is handling OPTIONS requests. If WebPieces doesn't route OPTIONS to controllers, the Express middleware approach (Step 4) is necessary.

2. **Environment Binding**: The Environment interface MUST be bound by the application. This is intentional - it forces apps to explicitly declare their environment.

3. **Security**: CORS is only enabled when `isCloud() === false`. Production environments should NEVER enable CORS this way.

4. **Headers**: The allowed headers list includes common headers. Apps may need to extend this list for custom headers.

## Testing the Fix

After implementing in webpieces-ts2:

1. Rebuild webpieces-ts2: `npm run build`
2. In webpieces-ts-example50:
   - Update to use local webpieces: `npm run use-local-webpieces`
   - Add Environment binding to CompanyModule
   - Restart server: `npm run start:server`
   - Restart client: `npm run start:client`
3. Test API call from browser - CORS error should be resolved
