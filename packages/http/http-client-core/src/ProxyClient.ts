import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMeta,
    AuthMeta,
    RouteMetadata,
    ProtocolError,
    LogApiCall,
} from '@webpieces/core-util';
import { ApiPrototype } from './ApiPrototype';
import { ClientErrorTranslator } from './ClientErrorTranslator';

/**
 * ProxyClient - the HTTP call engine behind one API contract's client proxy.
 *
 * Contains ONLY what a browser can run: the route map built from the contract's decorators, URL
 * assembly, `fetch`, error translation, and logging. It holds no context object, no credentials,
 * and no recorder — it ASKS ITSELF for those through the hooks below, and each subclass answers
 * from its own environment.
 *
 * That is why the class is abstract rather than parameterized by a collaborator: a shared
 * header-provider seam would drag Node's AsyncLocalStorage vocabulary into a browser bundle and the
 * browser's store vocabulary into a server, and neither has any use for the other.
 *
 *   NodeProxyClient    (@webpieces/http-client-node)    -> RequestContext, Secrets, mintIdToken, recording
 *   BrowserProxyClient (@webpieces/http-client-browser) -> an app-held store, no credentials, no recording
 *
 * TWO-PHASE: collaborators arrive on the subclass constructor (so a DI container can supply them),
 * while the per-client state — which contract, which target — arrives on the subclass's `init`,
 * which calls {@link initRoutes}. That is what lets a factory hold a `Provider<ProxyClient>` and
 * hand out a fresh, independently-configured client per contract.
 */
export abstract class ProxyClient {
    // Assigned by initRoutes(), which every subclass's init() calls immediately after construction.
    private routeMap!: Map<string, RouteMetadata>;
    private apiName!: string;

    constructor(protected readonly logApiCall: LogApiCall = new LogApiCall()) {}

    // ---------------------------------------------------------------- environment hooks

    /** The callee's base URL. Async because a server may derive it from container metadata. */
    protected abstract resolveBaseUrl(): Promise<string>;

    /** Context headers to put on the wire. Server reads RequestContext; browser reads its store. */
    protected abstract outboundHeaders(): Map<string, string>;

    /**
     * Attach the endpoint's outbound credential. Service-to-service auth (@AuthOidc bearer,
     * @AuthSharedSecret value) is a SERVER concept; a browser has neither a minter nor a Secrets
     * store, so it attaches nothing and its user JWT simply travels as a transferred context key.
     */
    protected async attachOutboundAuth(
        _route: RouteMetadata,
        _baseUrl: string,
        _httpHeaders: Record<string, string>,
    ): Promise<void> {}

    /**
     * Run the call. The default just logs it. Test-case RECORDING is a server concept, so
     * NodeProxyClient overrides this to capture the call when a recorder is in the context.
     *
     * Context fields are NOT passed in: a logging backend stamps them onto every record itself.
     */
    // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    protected async execute(
        route: RouteMetadata,
        requestDto: unknown,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
        method: () => Promise<unknown>,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    ): Promise<unknown> {
        return this.logApiCall.execute('CLIENT', route, requestDto, method);
    }

    /**
     * Reject, at bind time, an endpoint this environment cannot satisfy — e.g. a browser cannot
     * mint the OIDC token an @AuthOidc endpoint demands. Surfacing it here beats failing on the
     * first call in production. The default accepts everything.
     */
    protected assertEndpointSupported(_authMeta: AuthMeta | undefined, _methodName: string): void {}

    // ---------------------------------------------------------------- contract binding

    /**
     * Bind this client to one API contract: read @ApiPath/@Endpoint/@Auth* off the prototype and
     * build the route map once. Each subclass's `init(api, config)` stores its own config, then
     * calls this.
     *
     * @throws Error if the prototype lacks @ApiPath, or declares an endpoint this environment
     *         cannot satisfy (see {@link assertEndpointSupported}).
     */
    protected initRoutes(apiPrototype: ApiPrototype<object>): void {
        if (!isApiPath(apiPrototype)) {
            const className = apiPrototype.name || 'Unknown';
            throw new Error(`Class ${className} must be decorated with @ApiPath()`);
        }

        const basePath = getApiPath(apiPrototype)!;
        const endpoints = getEndpoints(apiPrototype) || {};

        // apiName as the class name so client logs read "SaveApi.save", not "undefined.save"
        this.apiName = apiPrototype.name || 'UnknownApi';

        this.routeMap = new Map<string, RouteMetadata>();
        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            const fullPath = basePath + endpointPath;
            // Capture the endpoint's auth mode so the client can mint delivery auth per
            // @AuthOidc / @AuthSharedSecret, exactly as the server verifies it.
            const authMeta = getAuthMeta(apiPrototype, methodName);
            this.assertEndpointSupported(authMeta, methodName);
            this.routeMap.set(methodName, new RouteMetadata('POST', fullPath, methodName, this.apiName, authMeta));
        }
    }

    /** The contract's class name, for logs and recordings. */
    protected contractName(): string {
        return this.apiName;
    }

    /** Check if a route exists for the given method name. */
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

    // ---------------------------------------------------------------- the call

    /**
     * Make an HTTP request based on route metadata and arguments.
     *
     * All endpoints are POST-only. The request body is the first argument.
     */
    // webpieces-disable no-any-unknown -- proxy method: the request DTO (args) + response are erased at the client boundary
    async makeRequest(route: RouteMetadata, args: any[]): Promise<any> {
        // Resolved per call (memoized underneath on a server), so building a client stayed synchronous.
        const baseUrl = await this.resolveBaseUrl();
        const url = `${baseUrl}${route.path}`;

        const httpHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Transferred context, request-id chained. The server impl throws here when there is no
        // active RequestContext — an outbound call with no trace is a bug, not a default.
        const outboundHeaders = this.outboundHeaders();
        for (const entry of outboundHeaders.entries()) {
            httpHeaders[entry[0]] = entry[1];
        }

        await this.attachOutboundAuth(route, baseUrl, httpHeaders);

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

        return await this.execute(route, requestDto, method);
    }

    /**
     * Execute the fetch request and handle response.
     */
    // webpieces-disable no-any-unknown -- the response DTO's type is erased at the proxy boundary
    private async executeFetch(url: string, options: RequestInit): Promise<unknown> {
        // webpieces-disable no-fetch -- this IS the generated-client implementation the rule points everyone to
        const response = await fetch(url, options);

        if (response.ok) {
            return await response.json();
        }

        // Handle errors (non-2xx responses): parse ProtocolError from the response body and
        // reconstruct the appropriate HttpError subclass.
        const protocolError = (await response.json()) as ProtocolError;
        throw ClientErrorTranslator.translateError(response, protocolError);
    }
}
