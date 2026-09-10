import {
    isApiPath,
    getApiPath,
    getEndpoints,
    getAuthMeta,
    isFormPost,
    isRawBody,
    getMaskSpec,
    AuthMeta,
    DestinationTrust,
    RouteMetadata,
    LogApiCallImpl,
    ApiMethodInfo,
    toError,
    NetworkRejectClassifier,
    FilterChain,
    CallRegistry,
    CallDeadline,
    CallContext,
} from '@webpieces/core-util';
import { ApiPrototype } from './ApiPrototype';
import { ClientFilterDefinition } from './ClientFilter';
import { ClientRequest } from './ClientRequest';
import { ClientErrorTranslator } from './ClientErrorTranslator';
import { HttpResponseDtoFactory } from './HttpResponseDtoFactory';
import { RequestOutcome } from './RequestOutcome';
import { ResponseBodyReader } from './ResponseBodyReader';
import { TranslatedFailure } from './TranslatedFailure';

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
    private apiClass!: ApiPrototype<object>;

    /**
     * The OUTBOUND filter chain, built once at bind time from {@link clientFilters} and reused for
     * every call. Built once rather than per call because a filter is STATELESS by contract (the
     * per-call state is the {@link ClientRequest} the chain is handed), exactly as on the server.
     */
    private chain!: FilterChain<ClientRequest, Response>;

    /**
     * The app's own filters, as handed to `createRpcClient`. Set by {@link initRoutes} BEFORE it
     * calls {@link clientFilters}, so an environment's built-ins may read the app's intent off them
     * — @webpieces/http-client-node takes the SSRF policy from an installed `ContextBaseUrlFilter`
     * that way, which keeps the one legitimate relaxation at the same construction site as the
     * decision to be re-pointable at all.
     */
    protected appFilters: ClientFilterDefinition[] = [];

    // Stateless + dependency-free, so the browser bundle keeps no DI on the fetch path.
    private readonly networkRejectClassifier = new NetworkRejectClassifier();

    // Same shape and same reason: stateless, so it is constructed here rather than injected.
    private readonly bodyReader = new ResponseBodyReader();

    /**
     * fetch `Response` -> the transport-neutral {@link HttpResponseDto} an app's `ErrorTranslators`
     * sees. Normalising HERE is what makes `fromWire` receive the identical shape in node and in the
     * browser: both environments share this class, and this is the only place either builds a DTO.
     */
    private readonly responseDtoFactory = new HttpResponseDtoFactory();

    /**
     * @param logApiCall - built by the SUBCLASS's package around that environment's ApiCallContext
     *   (node: RequestContextApiCallContext; browser: BrowserApiCallContext). REQUIRED, with no
     *   default: core-util cannot construct either one, and a default here would have to reach for a
     *   process-global — which is exactly the throw-on-first-call this parameter deleted.
     */
    constructor(protected readonly logApiCall: LogApiCallImpl) {}

    // ---------------------------------------------------------------- environment hooks

    /** The callee's base URL. Async because a server may derive it from container metadata. */
    protected abstract resolveBaseUrl(): Promise<string>;

    /**
     * Context headers to put on the wire. Server reads RequestContext; browser reads its store.
     *
     * `destination` is derived from THIS route's auth mode and decides whether TRUSTED context keys
     * (`x-user-id`, `x-org-id`, `x-webpieces-roles`) may ride along — see {@link DestinationTrust}.
     * It is a required argument on purpose: a defaulted "send everything" would put the permissive
     * answer one keystroke away and make the safe one opt-in.
     *
     * RENAMED from `outboundHeaders()` in the same change that added `destination`, and the rename IS
     * the migration. TypeScript accepts an override that declares FEWER parameters than its base, so a
     * downstream `protected override outboundHeaders(): Map<string, string>` would have kept compiling
     * and silently ignored the gate — the permissive behaviour surviving as a second spelling. Against
     * the NEW name that subclass fails twice over: `override` names a member the base no longer has,
     * and this abstract member is left unimplemented.
     */
    protected abstract outboundContextHeaders(destination: DestinationTrust): Map<string, string>;

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
        // apiClass = the CONTRACT name (this.apiName, e.g. 'SaveApi') so this client log line MATCHES
        // the server's for the same call. A client has no impl class, so controllerName is omitted.
        const info = new ApiMethodInfo(
            'client',
            this.apiName,
            route.methodName,
            undefined,
            route.mask,
        );
        return this.logApiCall.execute(info, requestDto, method);
    }

    /**
     * Reject, at bind time, an endpoint this environment cannot satisfy — e.g. a browser cannot
     * mint the OIDC token an @AuthOidc endpoint demands. Surfacing it here beats failing on the
     * first call in production. The default accepts everything.
     */
    protected assertEndpointSupported(_authMeta: AuthMeta | undefined, _methodName: string): void {}

    /**
     * The FRAMEWORK filters this environment installs on every client it builds, BENEATH whatever
     * the app passed to `createRpcClient`. The default installs none, so the browser runs the exact
     * code path it ran before the chain existed.
     *
     * "Beneath" is not a priority — see {@link initRoutes}. These are the filters that must judge
     * and sign what is ACTUALLY about to be sent, so no app priority may be allowed to get under
     * them: @webpieces/http-client-node installs its SSRF guard and its outbound-auth minter here,
     * and both would be defeated by an app filter that re-pointed the URL below them. Neither
     * concept can live in this class, because reading a RequestContext, resolving DNS and minting
     * an OIDC token are all things a browser bundle must never contain.
     */
    protected clientFilters(): ClientFilterDefinition[] {
        return [];
    }

    /**
     * Adapt a translated downstream failure into the error THIS environment's caller should see.
     *
     * THE INVARIANT, and the reason this hook exists at all:
     *
     *   A status received from a downstream dependency describes OUR request to it. It is never the
     *   status we return to OUR caller. The server that answered 404 is correct; the server that
     *   asked for a route that does not exist is broken, and must say so as a 500.
     *
     * That invariant reads differently in the two environments, which is exactly why the ISOMORPHIC
     * {@link ClientErrorTranslator} cannot settle it:
     * - BROWSER: the client IS the end user's agent, so the downstream IS the answer. Pass it through
     *   unchanged.
     * - NODE: server-to-server. A 4xx from a dependency is a caller-side defect (wrong path, wrong
     *   base URL, an undeployed dependency, bad service credentials), so the caller owns it as a 500.
     *
     * ABSTRACT, not a defaulted pass-through, for the same reason
     * {@link outboundContextHeaders} takes a required `destination`: a permissive default puts the
     * wrong answer one keystroke away. A new environment subclass must SAY which of the two it is,
     * and there are exactly two subclasses in the repo, so the compile error is the migration.
     *
     * @param failure - the translated error, its provenance (app-registered vs built-in), and the
     *                  downstream status
     * @param callId  - `ApiName.methodName`, so a rewritten message can still name the call
     */
    protected abstract adaptDownstreamFailure(failure: TranslatedFailure, callId: string): Error;

    /**
     * Fires before the logical call's attempts, once per RPC — the progress "start marker". Symmetric with
     * {@link onRequestEnd}: every start is followed by exactly one end, on every path, so a listener
     * can drive a counter (bar on / bar off) without leaking a permanently-spinning bar.
     *
     * The default is a no-op, so every existing subclass is unaffected.
     */
    protected onRequestStart(_route: RouteMetadata): void {}

    /**
     * Fires exactly ONCE after the call settles, on EVERY path (2xx, HTTP error, network reject) —
     * the "stop marker", carrying how it settled.
     *
     * Subsumes the older header-only hook: this is the ONLY place the `fetch` Response — and thus its
     * `Headers` — exists, so an app that needs to read a response header (e.g. a server-version stamp
     * for client↔server version matching) reads `outcome.headers` after settlement
     * and on both the ok and error paths. `outcome.ok`/`outcome.error` add the success-or-error
     * signal the header-only seam could not give.
     *
     * The default is a no-op, so every existing subclass is unaffected.
     */
    protected onRequestEnd(_route: RouteMetadata, _outcome: RequestOutcome): void {}

    // ---------------------------------------------------------------- contract binding

    /**
     * Bind this client to one API contract: read @ApiPath/@Endpoint/@Auth* off the prototype and
     * build the route map once. Each subclass's `init(api, config)` stores its own config, then
     * calls this.
     *
     * @param appFilters the app's OUTBOUND filters for this client, from `createRpcClient`. They are
     *        merged with {@link clientFilters} and sorted by priority, highest OUTERMOST.
     * @throws Error if the prototype lacks @ApiPath, or declares an endpoint this environment
     *         cannot satisfy (see {@link assertEndpointSupported}).
     */
    protected initRoutes(
        apiPrototype: ApiPrototype<object>,
        appFilters: ClientFilterDefinition[],
    ): void {
        this.appFilters = appFilters;
        this.apiClass = apiPrototype;
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
            const formPost = isFormPost(apiPrototype, methodName);
            this.routeMap.set(
                methodName,
                new RouteMetadata(
                    'POST',
                    fullPath,
                    methodName,
                    this.apiName,
                    authMeta,
                    undefined,
                    formPost,
                    getMaskSpec(apiPrototype, methodName),
                    isRawBody(apiPrototype, methodName),
                ),
            );
        }

        // APP filters first (highest priority OUTERMOST, matching the server's FilterMatcher), then
        // the framework built-ins, ALWAYS innermost. Two separate sorts rather than one over the
        // union, deliberately: an app priority orders app filters against each other and nothing
        // else, so no number an app can type — however large — gets underneath the SSRF guard or the
        // credential minter. A single sorted list would make "displace the guard" a matter of typing
        // a bigger integer, and a security control an app can outrank by accident is not a control.
        //
        // Sorted here, once, so FilterChain itself never sorts — priority lives on the DEFINITION,
        // not on the filter.
        const byPriority = (a: ClientFilterDefinition, b: ClientFilterDefinition): number =>
            b.priority - a.priority;
        const ordered = [
            ...[...this.appFilters].sort(byPriority),
            ...[...this.clientFilters()].sort(byPriority),
        ];
        this.chain = new FilterChain<ClientRequest, Response>(
            ordered.map((definition: ClientFilterDefinition) => definition.filter),
        );
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
     * FAIL FAST, PER METHOD, at call time: some endpoints exist for a caller that is not us, and this
     * proxy could only ever build a request they are obliged to reject. Refusing here rather than at
     * bind time means an api that MIXES such endpoints with normal ones still yields a working client
     * for the normal ones; only calling the un-callable method throws.
     *
     * @throws Error naming the endpoint, what it declared, and who its real caller is.
     */
    private refuseEndpointNoClientCanCall(route: RouteMetadata): void {
        // formPost exists ONLY for EXTERNAL inbound webhooks (e.g. Twilio is the caller). This proxy
        // JSON.stringifies the body, so calling one would silently send a wrong-encoded body.
        if (route.formPost) {
            throw new Error(
                `${this.apiName}.${route.methodName} is @Endpoint(..., { formPost: true }) — the ` +
                    `webpieces client does not support calling form-encoded endpoints yet. formPost is ` +
                    `for EXTERNAL inbound webhooks (e.g. Twilio) only. If this endpoint needs a ` +
                    `service-to-service client, set formPost:false (or remove it) so it uses JSON.`,
            );
        }
        const authMode = route.authMeta?.mode;
        // @AuthApiKey: the credential is a CUSTOMER-held key, and the header carrying it is the app's
        // ApiKeyHook's choice, so this client has nothing to send and the call is a guaranteed 401.
        if (authMode?.kind === 'apikey') {
            throw new Error(
                `${this.apiName}.${route.methodName} is @AuthApiKey('${authMode.regime}') — only the partner ` +
                    `holding that api key can call it, and the header carrying it is the app's ApiKeyHook's choice, ` +
                    `so a webpieces client has no credential to send.`,
            );
        }
        // @AuthWebhook is DELIBERATELY absent from this list. It used to be here, on the assumption
        // that the vendor is always somebody else — but `@AuthWebhook(name)` names a signing SCHEME,
        // not a direction, and for an OUTBOUND partner webhook WE are the vendor. The environment's
        // outbound-auth filter asks its bound signer to produce the signature, which is the exact
        // mirror of the inbound WebhookAuthCallback that verifies one.
    }

    /** One logical call: one lifecycle pair and log entry across all strategy attempts. */
    // webpieces-disable no-any-unknown -- request and response DTOs are erased at the proxy boundary
    async makeRequest(route: RouteMetadata, args: unknown[]): Promise<unknown> {
        this.refuseEndpointNoClientCanCall(route);
        const requestDto = args[0];
        return this.execute(route, requestDto, () => this.executeCall(route, requestDto));
    }

    // webpieces-disable no-any-unknown -- response DTO is erased at the proxy boundary
    private async executeCall(route: RouteMetadata, requestDto: unknown): Promise<unknown> {
        this.onRequestStart(route);
        let response: Response | undefined;
        // webpieces-disable no-any-unknown -- response DTO is erased at the proxy boundary
        let result: unknown;
        // webpieces-disable no-unmanaged-exceptions -- report one logical END, preserving the original thrown value
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            result = await CallRegistry.execute(
                this.apiClass,
                route.methodName,
                (timeoutMs: number) => {
                    response = undefined;
                    return CallDeadline.run(
                        timeoutMs,
                        new CallContext(this.apiName, route.methodName),
                        async (signal: AbortSignal) => {
                            const request = await this.prepareRequest(route, requestDto);
                            CallDeadline.throwIfAborted(signal);
                            const received = await this.chain.execute(request, () =>
                                this.sendOnce(request, signal),
                            );
                            CallDeadline.throwIfAborted(signal);
                            response = received;
                            return this.readResponse(received, route);
                        },
                    );
                },
                30_000,
            );
        } catch (err: unknown) {
            const error = toError(err);
            this.onRequestEnd(
                route,
                new RequestOutcome(false, response?.status ?? 0, response?.headers, error),
            );
            throw err;
        }
        this.onRequestEnd(
            route,
            new RequestOutcome(true, response?.status ?? 0, response?.headers),
        );
        return result;
    }

    /** Fresh mutable request for every attempt, including URL, headers, auth and body. */
    // webpieces-disable no-any-unknown -- request DTO is erased at the proxy boundary
    private async prepareRequest(
        route: RouteMetadata,
        requestDto: unknown,
    ): Promise<ClientRequest> {
        const baseUrl = await this.resolveBaseUrl();
        const headers = new Map<string, string>([['Content-Type', 'application/json']]);
        const context = this.outboundContextHeaders(
            DestinationTrust.forAuthMode(route.authMeta?.mode),
        );
        for (const entry of context.entries()) headers.set(entry[0], entry[1]);
        return new ClientRequest(
            route,
            this.apiName,
            baseUrl,
            headers,
            JSON.stringify(requestDto),
            requestDto,
        );
    }

    /**
     * ONE transmission — the bottom of the filter chain, and the only place `fetch` is called.
     *
     * Everything it sends comes off the {@link ClientRequest} as the chain left it, so a filter's
     * edits to the url, the headers or the serialized body are exactly what goes on the wire. It may
     * run more than once for a single RPC when a filter follows a redirect.
     *
     * A network reject (offline, DNS, CORS preflight) is classified into a typed OfflineError here (a
     * genuine bug passes through untouched) so that filters above see the same typed error the caller
     * will, rather than a raw platform reject.
     */
    private async sendOnce(request: ClientRequest, signal: AbortSignal): Promise<Response> {
        CallDeadline.throwIfAborted(signal);
        const options: RequestInit = {
            method: request.route.httpMethod,
            signal,
            headers: request.headersAsRecord(),
            redirect: request.followRedirects ? 'follow' : 'manual',
        };
        if (request.body !== undefined) {
            options.body = request.body;
        }
        // webpieces-disable no-unmanaged-exceptions -- classify a network reject, then rethrow it typed
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            // webpieces-disable no-fetch -- this IS the generated-client implementation the rule points everyone to
            return await fetch(request.url, options);
        } catch (err: unknown) {
            const error = toError(err);
            throw this.networkRejectClassifier.toNetworkError(error, request.url);
        }
    }

    /** Body consumption is inside the attempt deadline, including non-JSON error bodies. */
    // webpieces-disable no-any-unknown -- response DTO is erased at the proxy boundary
    private async readResponse(response: Response, route: RouteMetadata): Promise<unknown> {
        const callId = `${this.apiName}.${route.methodName}`;
        // 266 is protocol success, but its body represents an expected user exception.
        if (response.ok && response.status !== 266) {
            if (!this.bodyReader.isJson(response)) {
                throw new Error(
                    this.bodyReader.describeForeignBody(response, callId, await response.text()),
                );
            }
            return response.json();
        }
        const protocolError = await this.bodyReader.readErrorBody(response, callId);
        const translated = ClientErrorTranslator.translateError(
            this.responseDtoFactory.fromFetch(response, protocolError),
        );
        throw this.adaptDownstreamFailure(translated, callId);
    }
}
