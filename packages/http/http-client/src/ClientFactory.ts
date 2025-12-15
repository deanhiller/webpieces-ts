import {
    getRoutes,
    isApiInterface,
    RouteMetadata,
    ProtocolError,
    HeaderMethods,
    LogApiCall,
} from '@webpieces/http-api';
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
 * @param logApiCall - Optional LogApiCall instance (creates new one if not provided)
 * @returns A proxy object that implements the API interface
 */
export function createClient<T extends object>(
    apiPrototype: Function & { prototype: T },
    config: ClientConfig,
    contextMgr?: ContextMgr
): T {
    // Validate that the API prototype is marked with @ApiInterface
    if (!isApiInterface(apiPrototype)) {
        const className = apiPrototype.name || 'Unknown';
        throw new Error(`Class ${className} must be decorated with @ApiInterface()`);
    }

    // Get all routes from the API prototype
    const routes = getRoutes(apiPrototype);

    // Validate that all methods use @Post() - we only support POST for now
    for (const route of routes) {
        if (route.httpMethod !== 'POST') {
            throw new Error(
                `Method '${route.methodName}' uses @${route.httpMethod.charAt(0) + route.httpMethod.slice(1).toLowerCase()}() but we only support @Post() on methods right now. ` +
                `This is how gRPC, thrift, etc. all work - @Get is not needed but we may add later. ` +
                `Currently, no app has 'truly' needed it and only wanted to conform to ideals when in practice, ` +
                `there are no issues with @Post() and in fact @Post is more flexible as it can evolve to returning stuff later which happens frequently.`
            );
        }
    }

    // Create ProxyClient with injected LogApiCall (or create new one)
    //CRAP our own little DI going on here as angular and nodejs are using 2 different DI systems!!! fuck!!
    const proxyClient = new ProxyClient(
        config, new LogApiCall(), new HeaderMethods(), routes, contextMgr);

    // Create a proxy that intercepts method calls and makes HTTP requests
    return new Proxy({} as T, {
        get(target, prop: string | symbol) {
            // Only handle string properties (method names)
            if (typeof prop !== 'string') {
                throw new Error(`Method names must be strings, not ${typeof prop}`);
            }

            // Check if this property is actually a route method BEFORE calling getRoute()
            if (!proxyClient.hasRoute(prop)) {
                // For unknown properties (likely typos), throw a helpful error
                throw new Error(
                    `No route found for method '${prop}'. ` +
                    `Check for typos or ensure the method has @Post() decorator.`
                );
            }

            const route = proxyClient.getRoute(prop);

            // Return a function that makes the HTTP request
            return async (...args: any[]) => {
                return proxyClient.makeRequest(route, args);
            };
        },
    });
}

/**
 * ProxyClient - HTTP client implementation with logging.
 *
 * This class handles:
 * - Making HTTP requests based on route metadata
 * - Header propagation via ContextMgr
 * - Logging via LogApiCall
 * - Error translation via ClientErrorTranslator
 *
 * LogApiCall is injected for consistent logging across the framework.
 */
export class ProxyClient {
    private routeMap: Map<string, RouteMetadata>;

    constructor(
        private config: ClientConfig,
        private logApiCall: LogApiCall,
        private headerMethods: HeaderMethods,
        routes: RouteMetadata[],
        private contextMgr?: ContextMgr,
    ) {
        // Create a map of method name -> route metadata for fast lookup
        this.routeMap = new Map<string, RouteMetadata>();
        for (const route of routes) {
            this.routeMap.set(route.methodName, route);
        }
    }

    /**
     * Check if a route exists for the given method name.
     */
    hasRoute(methodName: string): boolean {
        return this.routeMap.has(methodName);
    }

    /**
     * Get route metadata for a method name.
     * @throws Error if no route found
     */
    getRoute(methodName: string): RouteMetadata {
        const route = this.routeMap.get(methodName);
        if (!route) {
            throw new Error(`No route found for method ${methodName}`);
        }
        return route;
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
     * Automatic header propagation via ContextMgr:
     * - If config.contextMgr is provided, reads headers from ContextReader
     * - Adds headers to request before fetch()
     *
     * Logging via LogApiCall.execute():
     * - [API-CLIENT-req] logs outgoing requests with headers (secure ones masked)
     * - [API-CLIENT-resp-SUCCESS] logs successful responses
     * - [API-CLIENT-resp-FAIL] logs failed responses
     */
    async makeRequest(route: RouteMetadata, args: any[]): Promise<any> {
        const { httpMethod, path } = route;

        // Build the full URL
        const url = `${this.config.baseUrl}${path}`;


        // Build base headers for the HTTP request
        const httpHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Add context headers to httpHeaders (unmasked, for actual HTTP request)
        if (this.contextMgr) {
            for (const header of this.contextMgr.headerSet) {
                const value = this.contextMgr.contextReader.read(header);
                if (value) {
                    httpHeaders[header.headerName] = value;
                }
            }
        }

        // Build masked headers map for logging
        const headersForLogging = this.contextMgr
            ? this.headerMethods.buildSecureMapForLogs(this.contextMgr.headerSet, this.contextMgr.contextReader)
            : new Map<string, any>();

        // Build request options
        const options: RequestInit = {
            method: httpMethod,
            headers: httpHeaders,
        };

        // For POST/PUT/PATCH, include the body (first argument) as JSON
        let requestDto: unknown;
        if (['POST', 'PUT', 'PATCH'].includes(httpMethod) && args.length > 0) {
            requestDto = args[0];
            // Plain JSON stringify - works with plain objects and our DateTimeDto classes
            options.body = JSON.stringify(requestDto);
        }

        // Wrap fetch in a method for LogApiCall.execute
        const method = async (): Promise<unknown> => {
            return this.executeFetch(url, options);
        };

        return await this.logApiCall.execute("CLIENT", route, requestDto, headersForLogging, method);
    }

    /**
     * Execute the fetch request and handle response.
     */
    private async executeFetch(url: string, options: RequestInit): Promise<unknown> {
        const response = await fetch(url, options);

        if (response.ok) {
            return await response.json();
        }

        // Handle errors (non-2xx responses)
        // Try to parse ProtocolError from response body
        const protocolError = (await response.json()) as ProtocolError;

        // Reconstruct appropriate HttpError subclass and throw
        throw ClientErrorTranslator.translateError(response, protocolError);
    }
}
