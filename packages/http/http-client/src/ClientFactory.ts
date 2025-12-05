import { getRoutes, isApiInterface, RouteMetadata, ProtocolError, HttpError } from '@webpieces/http-api';
import { ClientErrorTranslator } from './ClientErrorTranslator';
import { ContextMgr } from './ContextMgr';

/**
 * Configuration options for HTTP client.
 */
export class ClientConfig {
    /** Base URL for all requests (e.g., 'http://localhost:3000') */
    baseUrl: string;

    /**
     * Optional context manager for automatic header propagation.
     * When provided, headers will be read from the ContextReader and added to requests.
     */
    contextMgr?: ContextMgr;

    constructor(baseUrl: string, contextMgr?: ContextMgr) {
        this.baseUrl = baseUrl;
        this.contextMgr = contextMgr;
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
 *
 * NEW: Automatic header propagation via ContextMgr
 * - If config.contextMgr is provided, reads headers from ContextReader
 * - Adds headers to request before fetch()
 *
 * NEW: Client-side logging (similar to LogApiFilter on server)
 * - [API-CLIENT-req] logs outgoing requests
 * - [API-CLIENT-resp-SUCCESS] logs successful responses
 * - [API-CLIENT-resp-FAIL] logs failed responses
 */
async function makeRequest(config: ClientConfig, route: RouteMetadata, args: any[]): Promise<any> {
    const { httpMethod, path } = route;

    // Build the full URL
    const url = `${config.baseUrl}${path}`;

    // Build base headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    // NEW: Add headers from ContextMgr (if provided)
    // Single loop - ContextMgr.read() checks isWantTransferred and reads from context
    if (config.contextMgr) {
        for (const header of config.contextMgr.headerSet) {
            const value = config.contextMgr.read(header.headerName);
            if (value) {
                headers[header.headerName] = value;
            }
        }
    }

    // Build request options
    const options: RequestInit = {
        method: httpMethod,
        headers,
    };

    // For POST/PUT/PATCH, include the body (first argument) as JSON
    let requestDto: unknown;
    if (['POST', 'PUT', 'PATCH'].includes(httpMethod) && args.length > 0) {
        requestDto = args[0];
        // Plain JSON stringify - works with plain objects and our DateTimeDto classes
        options.body = JSON.stringify(requestDto);
    }

    // Log outgoing request
    logClientRequest(httpMethod, path, requestDto);

    try {
        // Make the HTTP request
        const response = await fetch(url, options);

        if (response.ok) {
            const responseDto = await response.json();
            // Log successful response
            logClientSuccessResponse(httpMethod, path, responseDto);
            return responseDto;
        }

        // Handle errors (non-2xx responses)
        // Try to parse ProtocolError from response body
        const protocolError = (await response.json()) as ProtocolError;

        // Log error response
        logClientErrorResponse(httpMethod, path, response.status, protocolError);

        // Reconstruct appropriate HttpError subclass
        throw ClientErrorTranslator.translateError(response, protocolError);
    } catch (error) {
        // Log network/fetch errors (not HTTP errors)
        if (!(error instanceof HttpError)) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[API-CLIENT-resp-FAIL] '${httpMethod} ${path}' networkError=${errorMessage}`);
        }
        throw error;
    }
}

/**
 * Log outgoing HTTP request.
 * Pattern: [API-CLIENT-req] 'METHOD /path' request={...}
 */
function logClientRequest(method: string, path: string, requestDto: unknown): void {
    console.log(`[API-CLIENT-req] '${method} ${path}' request=${JSON.stringify(requestDto ?? {})}`);
}

/**
 * Log successful HTTP response.
 * Pattern: [API-CLIENT-resp-SUCCESS] 'METHOD /path' response={...}
 */
function logClientSuccessResponse(method: string, path: string, responseDto: unknown): void {
    console.log(`[API-CLIENT-resp-SUCCESS] '${method} ${path}' response=${JSON.stringify(responseDto)}`);
}

/**
 * Log error HTTP response.
 * Pattern: [API-CLIENT-resp-FAIL] 'METHOD /path' status=XXX error=...
 */
function logClientErrorResponse(method: string, path: string, status: number, error: ProtocolError): void {
    console.error(`[API-CLIENT-resp-FAIL] '${method} ${path}' status=${status} error=${error.message}`);
}
