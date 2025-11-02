import { getRoutes, isApiInterface, RouteMetadata } from '@webpieces/http-api';

/**
 * Configuration options for HTTP client.
 */
export interface ClientConfig {
  /** Base URL for all requests (e.g., 'http://localhost:3000') */
  baseUrl: string;
  /** Optional headers to include in all requests */
  headers?: Record<string, string>;
  /** Optional fetch implementation (defaults to global fetch) */
  fetch?: typeof fetch;
}

/**
 * Creates a type-safe HTTP client from an API interface prototype.
 *
 * This is the client-side equivalent of RESTApiRoutes.
 * - Server: RESTApiRoutes reads decorators → routes HTTP requests to controllers
 * - Client: createClient reads decorators → generates HTTP requests from method calls
 *
 * Usage:
 * ```typescript
 * const client = createClient(SaveApiPrototype, { baseUrl: 'http://localhost:3000' });
 * const response = await client.save({ query: 'test' }); // Type-safe!
 * ```
 *
 * @param apiPrototype - The API prototype class with decorators (e.g., SaveApiPrototype)
 * @param config - Client configuration (baseUrl, headers, etc.)
 * @returns A proxy object that implements the API interface
 */
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
        return makeRequest(fetchImpl, config, route, args);
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
  args: any[]
): Promise<any> {
  const { httpMethod, path } = route;

  // Build the full URL
  const url = `${config.baseUrl}${path}`;

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.headers,
  };

  // Build request options
  const options: RequestInit = {
    method: httpMethod,
    headers,
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
