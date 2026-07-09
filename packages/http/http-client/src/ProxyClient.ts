import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMeta,
    RouteMetadata,
    ProtocolError,
    LogApiCall,
    RecordedEndpoint,
    RecordedError,
    RecorderKeys,
    TestCaseRecorder,
    toError,
    DocumentDesign,
} from '@webpieces/core-util';
import { ContextMgr, Secrets } from '@webpieces/core-util';
import { ClientErrorTranslator } from './ClientErrorTranslator';
import { ApiPrototype, ClientConfig, IdTokenMinter } from './ClientConfig';

/**
 * ProxyClient - the HTTP call engine behind one API contract's client proxy.
 *
 * Built by {@link ClientHttpFactory} (one per API contract), it owns:
 * - @ApiPath validation + the route map built from the contract's decorators
 * - Making HTTP requests based on that route metadata
 * - Header propagation via ContextMgr
 * - Outbound delivery auth (@AuthOidc bearer / @AuthSharedSecret value)
 * - Logging via LogApiCall, and test-case recording
 * - Error translation via ClientErrorTranslator
 *
 * It is the @DocumentDesign design root for this package: its constructor params ARE
 * the client's dependency graph. Collaborators (contextMgr / idTokenMinter / secrets)
 * are injected by the factory; {@link ClientConfig} carries only per-client STATE.
 */
@DocumentDesign()
export class ProxyClient {
    private routeMap: Map<string, RouteMetadata>;
    private apiName: string;

    // Our own little DI going on here as angular and nodejs are using 2 different DI systems;
    // LogApiCall is a typed param (with a default) so this reads as the client's dependency
    // graph in the generated design.
    constructor(
        apiPrototype: ApiPrototype<object>,
        private config: ClientConfig,
        private contextMgr?: ContextMgr,
        private idTokenMinter?: IdTokenMinter,
        private secrets?: Secrets,
        private logApiCall: LogApiCall = new LogApiCall(),
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
        if (hasOidcEndpoint && !this.idTokenMinter) {
            throw new Error(
                `API ${this.apiName} has @AuthOidc endpoint(s) but ClientHttpFactory has no idTokenMinter. ` +
                `Browsers cannot mint OIDC tokens; build this client server-side with ` +
                `new ClientHttpFactory(contextMgr, mintIdToken) from @webpieces/gcp-identity.`
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
     * Attach the outbound credential for the endpoint's AuthMode: an @AuthOidc bearer minted as this
     * caller's runtime SA (audience = the callee base URL, via the injected gcp-identity minter — the
     * server verifies the signature + caller allow-list), or the @AuthSharedSecret(key) value THIS
     * client sends from its bound {@link Secrets}. Symmetric with the Cloud Tasks invokers; never
     * reads process.env.
     */
    private async attachOutboundAuth(route: RouteMetadata, httpHeaders: Record<string, string>): Promise<void> {
        const mode = route.authMeta?.mode;
        if (mode?.kind === 'oidc') {
            if (!this.idTokenMinter) {
                throw new Error(`No idTokenMinter configured for @AuthOidc endpoint ${route.methodName}`);
            }
            httpHeaders['Authorization'] = `Bearer ${await this.idTokenMinter(this.config.baseUrl)}`;
        } else if (mode?.kind === 'shared-secret') {
            const secret = this.secrets?.get(mode.secretKey);
            if (!secret) {
                throw new Error(`No shared secret configured for @AuthSharedSecret('${mode.secretKey}') endpoint ${route.methodName}`);
            }
            httpHeaders['x-webpieces-shared-secret'] = secret;
        }
    }

    /**
     * Make an HTTP request based on route metadata and arguments.
     *
     * All endpoints are POST-only. The request body is the first argument.
     */
    // webpieces-disable no-any-unknown -- proxy method: the request DTO (args) + response are erased at the client boundary
    async makeRequest(route: RouteMetadata, args: any[]): Promise<any> {
        // Build the full URL
        const url = `${this.config.baseUrl}${route.path}`;

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

        // Attach the endpoint's outbound credential (@AuthOidc bearer / @AuthSharedSecret value).
        await this.attachOutboundAuth(route, httpHeaders);

        // Build masked headers map for logging (secured values masked, MDC keys)
        const headersForLogging = this.contextMgr
            ? this.contextMgr.buildHeadersForLogging()
            : new Map<string, string>();

        // Build request options
        const options: RequestInit = {
            method: route.httpMethod,
            headers: httpHeaders,
        };

        // POST body is the first argument as JSON
        // webpieces-disable no-any-unknown -- the request DTO's type is erased at the proxy boundary
        let requestDto: unknown;
        if (args.length > 0) {
            requestDto = args[0];
            options.body = JSON.stringify(requestDto);
        }

        // Wrap fetch in a method for LogApiCall.execute
        // webpieces-disable no-any-unknown -- the response DTO's type is erased at the proxy boundary
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
    // webpieces-disable no-any-unknown -- the response DTO's type is erased at the proxy boundary
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
