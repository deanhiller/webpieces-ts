import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMeta,
    RouteMetadata,
    ProtocolError,
    HeaderMethods,
    LogApiCall,
    RecordedEndpoint,
    RecordedError,
    RecorderKeys,
    TestCaseRecorder,
    toError,
    DocumentDesign,
} from '@webpieces/core-util';
import { ContextMgr } from '@webpieces/core-util';
import { ClientErrorTranslator } from './ClientErrorTranslator';

/**
 * Type representing a class constructor whose prototype is T.
 * Used as the apiPrototype parameter for createApiClient.
 */
type ApiPrototype<T> = Function & { prototype: T };

/**
 * Mints a Google OIDC ID token for an @AuthOidc endpoint (audience = callee
 * base URL). Server-side callers pass gcp-identity's `mintIdToken`; browsers
 * cannot mint service-to-service tokens and pass nothing (see the fail-fast in
 * ProxyClient's constructor). Keeping this a seam is what makes http-client a
 * browser-safe, isomorphic package (no static @webpieces/gcp-identity import).
 */
export type IdTokenMinter = (audience: string) => Promise<string>;

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

    /**
     * Optional OIDC ID-token minter for @AuthOidc endpoints (server-side only).
     * Browsers leave this undefined; a client built for an API that has any
     * @AuthOidc endpoint without a minter fails fast at construction.
     */
    idTokenMinter?: IdTokenMinter;

    constructor(baseUrl: string, contextMgr?: ContextMgr, idTokenMinter?: IdTokenMinter) {
        this.baseUrl = baseUrl;
        this.contextMgr = contextMgr;
        this.idTokenMinter = idTokenMinter;
    }
}

/**
 * Return type for the Proxy get trap — either an async method or undefined for framework inspection.
 */
// webpieces-disable no-any-unknown -- Proxy get trap returns generic response promises
type ProxyGetResult = (...args: never[]) => Promise<unknown>;

/**
 * Properties accessed by DI frameworks (Angular, Vue), debuggers, Promise checks, and serializers.
 * These should return undefined instead of throwing, allowing frameworks to inspect the proxy.
 *
 * Why this exists:
 * - Angular's injector profiler accesses `constructor` after useFactory returns
 * - Promise.resolve() checks for `then` to detect thenables
 * - JSON.stringify checks for `toJSON`
 * - Debuggers access `prototype`, `__proto__`, etc.
 */
const FRAMEWORK_INSPECTION_PROPERTIES = new Set([
    'constructor',     // Angular DI profiler, class inspection
    'prototype',       // Prototype chain inspection
    '__proto__',       // Legacy prototype access
    'name',            // Angular isNotFound() check, function/class name inspection
    'then',            // Promise/thenable detection
    'catch',           // Promise check
    'finally',         // Promise check
    'toJSON',          // JSON.stringify
    'valueOf',         // Type coercion
    'toString',        // String coercion
    'nodeType',        // DOM element check
    'tagName',         // DOM element check
    '$$typeof',        // React element/component check
    '$typeof',         // React internal
    '_isVue',          // Vue internal
    'ngOnInit',        // Angular lifecycle hook check
    'ngOnDestroy',     // Angular lifecycle hook check
    'ngOnChanges',     // Angular lifecycle hook check
    'asymmetricMatch', // Jest matcher protocol
]);

/**
 * Creates a type-safe HTTP client from an API prototype with @ApiPath/@Endpoint decorators.
 *
 * This is the client-side equivalent of ApiRoutingFactory.
 * - Server: ApiRoutingFactory reads decorators -> routes HTTP requests to controllers
 * - Client: createApiClient reads decorators -> generates HTTP requests from method calls
 *
 * Usage:
 * ```typescript
 * const config = new ClientConfig('http://localhost:3000');
 * const client = createApiClient(SaveApi, config);
 * const response = await client.save({ query: 'test' }); // Type-safe!
 * ```
 *
 * BREAKING CHANGE (for library consumers): the positional 3rd `contextMgr`
 * parameter was removed - it silently shadowed `ClientConfig.contextMgr`,
 * which was ignored. Migration: pass it in the config instead:
 *   createApiClient(Api, new ClientConfig(baseUrl, contextMgr))
 *
 * @param apiPrototype - The API prototype class with @ApiPath/@Endpoint decorators
 * @param config - Client configuration with baseUrl and optional contextMgr
 * @returns A proxy object that implements the API interface
 */
export function createApiClient<T extends object>(
    apiPrototype: ApiPrototype<T>,
    config: ClientConfig
): T {
    // ProxyClient owns @ApiPath validation + route building from the API's decorators
    // (see its constructor). It is the @DocumentDesign design root for this package.
    const proxyClient = new ProxyClient(apiPrototype, config);

    // Create a proxy that intercepts method calls and makes HTTP requests
    return new Proxy({} as T, {
        get(target, prop: string | symbol): ProxyGetResult | undefined {
            // Symbols (Symbol.toStringTag, Symbol.iterator, etc.) - throw for now to learn if this happens
            if (typeof prop !== 'string') {
                throw new Error(
                    `Proxy accessed with non-string property: ${String(prop)} (type: ${typeof prop}). ` +
                    `Please report this so we can add it to the whitelist.`
                );
            }

            // Framework inspection properties - return undefined to allow inspection
            // WITHOUT throwing. This is critical for Angular DI, Promise checks, etc.
            if (FRAMEWORK_INSPECTION_PROPERTIES.has(prop)) {
                return undefined;
            }

            // Check if this property is actually a route method
            if (!proxyClient.hasRoute(prop)) {
                // For unknown properties (likely typos), throw a helpful error
                throw new Error(
                    `No route found for method '${prop}'. ` +
                    `Check for typos or ensure the method has @Endpoint() decorator.`
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
@DocumentDesign()
export class ProxyClient {
    private routeMap: Map<string, RouteMetadata>;
    private contextMgr?: ContextMgr;
    private apiName: string;

    // Our own little DI going on here as angular and nodejs are using 2 different DI systems;
    // LogApiCall/HeaderMethods are typed params (with defaults) so this reads as the client's
    // dependency graph in the generated design.
    constructor(
        apiPrototype: ApiPrototype<object>,
        private config: ClientConfig,
        private logApiCall: LogApiCall = new LogApiCall(),
        private headerMethods: HeaderMethods = new HeaderMethods(),
    ) {
        // Validate that the API prototype is marked with @ApiPath
        if (!isApiPath(apiPrototype)) {
            const className = apiPrototype.name || 'Unknown';
            throw new Error(`Class ${className} must be decorated with @ApiPath()`);
        }

        const basePath = getApiPath(apiPrototype)!;
        const endpoints = getEndpoints(apiPrototype) || {};

        // apiName as the class name so client logs read "SaveApi.save", not "undefined.save"
        this.apiName = apiPrototype.name || 'UnknownApi';
        this.contextMgr = config.contextMgr;

        // Build the map of method name -> route metadata from @ApiPath + @Endpoint metadata
        this.routeMap = new Map<string, RouteMetadata>();
        let hasOidcEndpoint = false;
        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            const fullPath = basePath + endpointPath;
            // Capture the endpoint's auth mode so the client can mint delivery auth
            // (OIDC bearer) per @AuthOidc / @AuthSharedSecret, just like the server verifies it.
            const authMeta = getAuthMeta(apiPrototype, methodName);
            if (authMeta?.mode.kind === 'oidc') {
                hasOidcEndpoint = true;
            }
            this.routeMap.set(methodName, new RouteMetadata('POST', fullPath, methodName, this.apiName, authMeta));
        }

        // Fail fast: an @AuthOidc endpoint needs a server-side OIDC minter. Browsers
        // cannot mint service-to-service tokens, so a client built for such an API
        // without a minter is a wiring bug — surface it here, not on first call.
        if (hasOidcEndpoint && !config.idTokenMinter) {
            throw new Error(
                `API ${this.apiName} has @AuthOidc endpoint(s) but ClientConfig has no idTokenMinter. ` +
                `Browsers cannot mint OIDC tokens; build this client server-side with ` +
                `new ClientConfig(baseUrl, contextMgr, mintIdToken) from @webpieces/gcp-identity.`
            );
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
     * All endpoints are POST-only. The request body is the first argument.
     */
    async makeRequest(route: RouteMetadata, args: any[]): Promise<any> {
        const { httpMethod, path } = route;

        // Build the full URL
        const url = `${this.config.baseUrl}${path}`;

        // Build base headers for the HTTP request
        const httpHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Add context headers to httpHeaders (unmasked, for actual HTTP request).
        // ContextMgr owns the logic: transferred-only, request-id chaining applied.
        if (this.contextMgr) {
            const outboundHeaders = this.contextMgr.buildOutboundHeaders();
            for (const entry of outboundHeaders.entries()) {
                httpHeaders[entry[0]] = entry[1];
            }
        }

        // For an @AuthOidc endpoint, attach a Google ID token minted as THIS caller's
        // own runtime SA (audience = the callee base URL), via the injected minter
        // (server-side gcp-identity.mintIdToken). The server verifies the signature
        // AND that this SA is in the endpoint's allow-list. Guaranteed present by the
        // ProxyClient constructor's fail-fast check, but guarded here defensively.
        if (route.authMeta?.mode.kind === 'oidc') {
            const idTokenMinter = this.config.idTokenMinter;
            if (!idTokenMinter) {
                throw new Error(`No idTokenMinter configured for @AuthOidc endpoint ${route.methodName}`);
            }
            httpHeaders['Authorization'] = `Bearer ${await idTokenMinter(this.config.baseUrl)}`;
        }

        // Build masked headers map for logging (secured values masked, MDC keys)
        const headersForLogging = this.contextMgr
            ? this.contextMgr.buildHeadersForLogging(this.headerMethods)
            : new Map<string, string>();

        // Build request options
        const options: RequestInit = {
            method: httpMethod,
            headers: httpHeaders,
        };

        // POST body is the first argument as JSON
        let requestDto: unknown;
        if (args.length > 0) {
            requestDto = args[0];
            options.body = JSON.stringify(requestDto);
        }

        // Wrap fetch in a method for LogApiCall.execute
        const method = async (): Promise<unknown> => {
            return this.executeFetch(url, options);
        };

        // Test-case recording hook (mirror of Java HttpsJsonClientInvokeHandler):
        // if a recorder is traveling in the magic context, capture this outbound
        // call + its result so it becomes a mock in the generated test.
        const recorder = this.findRecorder();
        if (!recorder) {
            return await this.logApiCall.execute("CLIENT", route, requestDto, headersForLogging, method);
        }
        return await this.recordCall(recorder, route, requestDto, headersForLogging, method);
    }

    /**
     * Find the active TestCaseRecorder via the injected ContextReader.
     * Uses the OPTIONAL readValue() so http-client stays free of Node imports;
     * browser readers simply don't implement it (no recording in browsers).
     */
    private findRecorder(): TestCaseRecorder | undefined {
        const reader = this.contextMgr?.contextReader;
        if (!reader || !reader.readValue) {
            return undefined;
        }
        return reader.readValue(RecorderKeys.RECORDER) as TestCaseRecorder | undefined;
    }

    /**
     * Execute the call while recording it (args + masked ctx snapshot + result).
     */
    // webpieces-disable no-any-unknown -- DTO types are erased at the proxy layer
    private async recordCall(
        recorder: TestCaseRecorder,
        route: RouteMetadata,
        requestDto: unknown,
        headersForLogging: Map<string, string>,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy layer
        method: () => Promise<unknown>,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy layer
    ): Promise<unknown> {
        const ctxSnapshot: Record<string, string> = {};
        for (const entry of headersForLogging.entries()) {
            ctxSnapshot[entry[0]] = entry[1];
        }
        const recorded = new RecordedEndpoint(this.apiName, route.methodName, [requestDto], ctxSnapshot);
        recorder.addEndpointInfo(recorded);

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- capture failure into the recording, then rethrow unchanged
        try {
            const response = await this.logApiCall.execute("CLIENT", route, requestDto, headersForLogging, method);
            recorded.successResponse = response;
            return response;
        } catch (err: unknown) {
            const error = toError(err);
            recorded.failureResponse = new RecordedError(error.name, error.message);
            throw err;
        }
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
