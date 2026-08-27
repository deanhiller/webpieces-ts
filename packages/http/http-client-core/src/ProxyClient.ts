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
    LogApiCall,
    LogApiCallImpl,
    ApiMethodInfo,
    toError,
    NetworkRejectClassifier,
    FilterChain,
} from '@webpieces/core-util';
import { ApiPrototype } from './ApiPrototype';
import { ClientFilterDefinition } from './ClientFilter';
import { ClientRequest } from './ClientRequest';
import { ClientErrorTranslator } from './ClientErrorTranslator';
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

    /**
     * The OUTBOUND filter chain, built once at bind time from {@link clientFilters} and reused for
     * every call. Built once rather than per call because a filter is STATELESS by contract (the
     * per-call state is the {@link ClientRequest} the chain is handed), exactly as on the server.
     */
    private chain!: FilterChain<ClientRequest, Response>;

    /** The app's own filters, as handed to `createRpcClient`. Stored only to build {@link chain}. */
    private appFilters: ClientFilterDefinition[] = [];

    // Stateless + dependency-free, so the browser bundle keeps no DI on the fetch path.
    private readonly networkRejectClassifier = new NetworkRejectClassifier();

    // Same shape and same reason: stateless, so it is constructed here rather than injected.
    private readonly bodyReader = new ResponseBodyReader();

    constructor(protected readonly logApiCall: LogApiCallImpl = LogApiCall) {}

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
     * Attach the endpoint's outbound credential. Service-to-service auth (@AuthOidc bearer,
     * @AuthSharedSecret value) is a SERVER concept; a browser has neither a minter nor a Secrets
     * store, so it attaches nothing and its user JWT simply travels as a transferred context key.
     */
    protected async attachOutboundAuth(
        _route: RouteMetadata,
        _baseUrl: string,
        _httpHeaders: Map<string, string>,
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
        // apiClass = the CONTRACT name (this.apiName, e.g. 'SaveApi') so this client log line MATCHES
        // the server's for the same call. A client has no impl class, so controllerName is omitted.
        const info = new ApiMethodInfo('client', this.apiName, route.methodName, undefined, route.mask);
        return this.logApiCall.execute(info, requestDto, method);
    }

    /**
     * Reject, at bind time, an endpoint this environment cannot satisfy — e.g. a browser cannot
     * mint the OIDC token an @AuthOidc endpoint demands. Surfacing it here beats failing on the
     * first call in production. The default accepts everything.
     */
    protected assertEndpointSupported(_authMeta: AuthMeta | undefined, _methodName: string): void {}

    /**
     * The FRAMEWORK filters this environment installs on every client it builds, on top of whatever
     * the app passed to `createRpcClient`. The default installs none, so a client with no app
     * filters runs the exact code path it ran before the chain existed.
     *
     * This is the seam the runtime base-URL override lives behind: @webpieces/http-client-node
     * returns the filters its `ClientConfig`'s host policy demands — the one that reads
     * `WebpiecesCoreHeaders.OVERRIDE_BASE_URL` out of the ambient RequestContext, and the SSRF guard
     * that then judges what it found. Neither concept can live here, because reading a
     * RequestContext and resolving DNS are both things a browser bundle must never contain.
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
     * Fires immediately BEFORE `fetch`, once per RPC — the progress "start marker". Symmetric with
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
     * for client↔server version matching) reads `outcome.headers`, still BEFORE the body is consumed
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
    protected initRoutes(apiPrototype: ApiPrototype<object>, appFilters: ClientFilterDefinition[]): void {
        this.appFilters = appFilters;
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
                    'POST', fullPath, methodName, this.apiName, authMeta, undefined, formPost,
                    getMaskSpec(apiPrototype, methodName), isRawBody(apiPrototype, methodName),
                ),
            );
        }

        // Highest priority OUTERMOST, matching the server's FilterMatcher. Sorted here, once, so
        // FilterChain itself never sorts — priority lives on the DEFINITION, not on the filter.
        const definitions = [...this.clientFilters(), ...this.appFilters];
        definitions.sort((a, b) => b.priority - a.priority);
        this.chain = new FilterChain<ClientRequest, Response>(definitions.map((d) => d.filter));
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
        // @AuthWebhook: verified by the VENDOR's signature over the request, which nothing here can produce.
        if (authMode?.kind === 'webhook') {
            throw new Error(
                `${this.apiName}.${route.methodName} is @AuthWebhook('${authMode.name}') — only ` +
                `${authMode.name} can call it, because only ${authMode.name} can produce the signature ` +
                `its WebhookAuthCallback verifies. It is not callable from a webpieces client.`,
            );
        }
    }

    /**
     * Make an HTTP request based on route metadata and arguments.
     *
     * All endpoints are POST-only. The request body is the first argument.
     */
    // webpieces-disable no-any-unknown -- proxy method: the request DTO (args) + response are erased at the client boundary
    async makeRequest(route: RouteMetadata, args: any[]): Promise<any> {
        this.refuseEndpointNoClientCanCall(route);
        // Resolved per call (memoized underneath on a server), so building a client stayed synchronous.
        const baseUrl = await this.resolveBaseUrl();

        const httpHeaders = new Map<string, string>([['Content-Type', 'application/json']]);

        // Transferred context, request-id chained. The server impl throws here when there is no
        // active RequestContext — an outbound call with no trace is a bug, not a default. The
        // destination's own auth mode decides whether trusted keys are part of that set.
        const contextHeaders = this.outboundContextHeaders(DestinationTrust.forAuthMode(route.authMeta?.mode));
        for (const entry of contextHeaders.entries()) {
            httpHeaders.set(entry[0], entry[1]);
        }

        await this.attachOutboundAuth(route, baseUrl, httpHeaders);

        // POST body is the first argument as JSON. Serialized HERE, before the filter chain, so a
        // filter that signs the request signs the exact bytes {@link sendOnce} will transmit.
        // webpieces-disable no-any-unknown -- the request DTO's type is erased at the proxy boundary
        let requestDto: unknown;
        let body: string | undefined;
        if (args.length > 0) {
            requestDto = args[0];
            body = JSON.stringify(requestDto);
        }

        const request = new ClientRequest(route, this.apiName, baseUrl, httpHeaders, body, requestDto);

        // Wrap the send in a method for LogApiCall.execute
        // webpieces-disable no-any-unknown -- the response DTO's type is erased at the proxy boundary
        const method = async (): Promise<unknown> => {
            return this.executeFetch(request);
        };

        return await this.execute(route, requestDto, method);
    }

    /**
     * Execute the fetch request and handle response.
     *
     * Brackets the call with the lifecycle seam: {@link onRequestStart} once before `fetch`, then
     * {@link onRequestEnd} exactly once on each of the three ways a call can settle. The end hook
     * fires BEFORE the throw on both failure paths, so a listener always sees the stop marker even
     * though the caller sees an exception.
     */
    // webpieces-disable no-any-unknown -- the response DTO's type is erased at the proxy boundary
    private async executeFetch(request: ClientRequest): Promise<unknown> {
        const route = request.route;
        this.onRequestStart(route);

        // The START marker fires ONCE per RPC even though a filter may send more than once (the SSRF
        // guard re-invokes the chain to follow a validated redirect) — start and end still pair up
        // exactly, which is what lets a listener drive a progress counter.
        let response: Response;
        // webpieces-disable no-unmanaged-exceptions -- translate a send failure into a lifecycle END, then rethrow
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            response = await this.chain.execute(request, () => this.sendOnce(request));
        } catch (err: unknown) {
            // No Response ever existed — a network reject already classified by sendOnce, or a filter
            // that refused to send at all (an SSRF policy rejecting a partner's URL). Either way there
            // is no status and no headers to report, only status 0 and the failure itself, and the
            // lifecycle listener must see the SAME error the caller is about to.
            const error = toError(err);
            this.onRequestEnd(route, new RequestOutcome(false, 0, undefined, error));
            throw error;
        }

        const callId = `${this.apiName}.${route.methodName}`;
        if (response.ok) {
            return this.readSuccessBody(response, route, callId);
        }
        throw await this.endWithTypedFailure(response, route, callId);
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
    private async sendOnce(request: ClientRequest): Promise<Response> {
        const options: RequestInit = {
            method: request.route.httpMethod,
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
            throw this.networkRejectClassifier.toNetworkError(toError(err), request.url);
        }
    }

    /**
     * Read a 2xx body, reporting the END marker on both outcomes.
     *
     * The content-type gate is the same one the error path uses: a 2xx that is not JSON (a proxy's
     * captive-portal page, an SPA index.html served by a misrouted CDN) is reported for WHAT ARRIVED,
     * instead of `SyntaxError: Unexpected token '<'`, which names nothing a reader can act on.
     */
    // webpieces-disable no-any-unknown -- the response DTO's type is erased at the proxy boundary
    private async readSuccessBody(response: Response, route: RouteMetadata, callId: string): Promise<unknown> {
        // webpieces-disable no-unmanaged-exceptions -- a malformed 2xx body must still report the END marker
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            if (!this.bodyReader.isJson(response)) {
                throw new Error(this.bodyReader.describeForeignBody(response, callId, await response.text()));
            }
            const body = await response.json();
            this.onRequestEnd(route, new RequestOutcome(true, response.status, response.headers));
            return body;
        } catch (err: unknown) {
            const error = toError(err);
            this.onRequestEnd(route, new RequestOutcome(false, response.status, response.headers, error));
            throw error;
        }
    }

    /**
     * Turn a non-2xx response into the error the caller will see, firing the END marker first — so a
     * listener always gets its stop marker even though the caller sees an exception. RETURNS the
     * error rather than throwing it, which keeps the one `throw` visible at the call site.
     *
     * The headers still reach the seam here, so a version (or any future) header is observed even on
     * error responses.
     *
     * The body is read through {@link ResponseBodyReader}, which parses ONLY a body whose
     * content-type says it is JSON. An infra 502/503/504 (load balancer, proxy, cold start on a
     * scale-to-zero backend) serves HTML, and parsing that used to throw `SyntaxError: Unexpected
     * token '<'` — discarding the status, so the caller could not tell a booting server from a broken
     * client. It now becomes a synthesized ProtocolError translated BY STATUS, i.e. a real
     * `HttpBadGatewayError` / `HttpServiceUnavailableError` / `HttpGatewayTimeoutError`.
     *
     * The try/catch stays, for a NARROWER job than before: a body that DECLARED json and was
     * malformed still throws (that one is a genuine server bug), and the END marker must fire for it
     * too — an unreported end leaves the app's progress bar spinning forever.
     *
     * `translated` is what ClientErrorTranslator picked, and translateError RETURNS a
     * {@link TranslatedFailure} — so nothing in this seam is ever `unknown`.
     *
     * The translated failure then goes through {@link adaptDownstreamFailure}, which is where the two
     * environments part company (browser rethrows it, node turns a downstream 4xx into its own 500).
     *
     * The RequestOutcome reported to {@link onRequestEnd} carries the POST-adapt error, deliberately:
     * a lifecycle listener must see the SAME error the caller sees, or a progress bar / error toast
     * says 404 while the thrown exception says 500. That is the identical rule the network-reject path
     * already follows (it classifies BEFORE onRequestEnd for exactly this reason). The pre-adapt error
     * is not lost — it is the adapted error's `httpCause`.
     */
    private async endWithTypedFailure(response: Response, route: RouteMetadata, callId: string): Promise<Error> {
        let translated: TranslatedFailure;
        // webpieces-disable no-unmanaged-exceptions -- a malformed JSON error body must still report the END marker
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const protocolError = await this.bodyReader.readErrorBody(response, callId);
            translated = ClientErrorTranslator.translateError(response, protocolError);
        } catch (err: unknown) {
            const error = toError(err);
            // The response CLAIMED JSON and was not parseable — report that failure as the outcome.
            // It never reaches adaptDownstreamFailure: there is no translated status to adapt, and a
            // body that broke its own content-type promise is already a defect, not a status answer.
            this.onRequestEnd(route, new RequestOutcome(false, response.status, response.headers, error));
            return error;
        }

        const adapted = this.adaptDownstreamFailure(translated, callId);
        this.onRequestEnd(route, new RequestOutcome(false, response.status, response.headers, adapted));
        return adapted;
    }
}
