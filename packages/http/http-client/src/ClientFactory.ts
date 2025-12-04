import { getRoutes, isApiInterface, RouteMetadata, ProtocolError, HttpError } from '@webpieces/http-api';
import { ClientErrorTranslator } from './ClientErrorTranslator';

/**
 * Configuration options for HTTP client.
 */
export class ClientConfig {
    /** Base URL for all requests (e.g., 'http://localhost:3000') */
    baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }
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
 * const config = new ClientConfig('http://localhost:3000');
 * const client = createClient(SaveApiPrototype, config);
 * const response = await client.save({ query: 'test' }); // Type-safe!
 * ```
 *
 * @param apiPrototype - The API prototype class with decorators (e.g., SaveApiPrototype)
 * @param config - Client configuration with baseUrl
 * @returns A proxy object that implements the API interface
 */
export function createClient<T extends object>(
    apiPrototype: Function & { prototype: T },
    config: ClientConfig,
): T {
    // Validate that the API prototype is marked with @ApiInterface
    if (!isApiInterface(apiPrototype)) {
        const className = apiPrototype.name || 'Unknown';
        throw new Error(`Class ${className} must be decorated with @ApiInterface()`);
    }

    // Get all routes from the API prototype
    const routes = getRoutes(apiPrototype);

    // Create a map of method name -> route metadata for fast lookup
    const routeMap = new Map<string, RouteMetadata>();
    for (const route of routes) {
        routeMap.set(route.methodName, route);
    }

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
                return makeRequest(config, route, args);
            };
        },
    });
}

/**
 * Make an HTTP request based on route metadata and arguments.
 *
 * Uses plain JSON.stringify/parse - no serialization library needed!
 *
 * Error handling:
 * - Server: Throws HttpError → translates to ProtocolError JSON
 * - Client: Receives ProtocolError JSON → reconstructs HttpError
 */
async function makeRequest(config: ClientConfig, route: RouteMetadata, args: any[]): Promise<any> {
    const { httpMethod, path } = route;

    // Build the full URL
    const url = `${config.baseUrl}${path}`;

    // Build headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    // Build request options
    const options: RequestInit = {
        method: httpMethod,
        headers,
    };

    // For POST/PUT/PATCH, include the body (first argument) as JSON
    if (['POST', 'PUT', 'PATCH'].includes(httpMethod) && args.length > 0) {
        const requestDto = args[0];
        // Plain JSON stringify - works with plain objects and our DateTimeDto classes
        options.body = JSON.stringify(requestDto);
    }

    // Make the HTTP request
    const response = await fetch(url, options);

    if(response.ok) {
        return response.json();
    }

    // Handle errors (non-2xx responses)

    // Try to parse ProtocolError from response body
    const protocolError = (await response.json()) as ProtocolError;
    // Reconstruct appropriate HttpError subclass
    throw ClientErrorTranslator.translateError(response, protocolError);
}
