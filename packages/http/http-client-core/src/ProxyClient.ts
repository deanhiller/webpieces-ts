import {
    isApiPath,
    getEndpoints,
    AuthMeta,
    DestinationTrust,
    RouteMetadata,
    LogApiCallImpl,
    ApiMethodInfo,
    toError,
    NetworkRejectClassifier,
    HttpContractMapper,
    RouteMetadataFactory,
    FilterChain,
    CallRegistry,
    CallDeadline,
    CallContext,
    DtoValue,
    RequestStream,
    ResponseStream,
    StreamTransportError,
} from '@webpieces/core-util';
import { ApiPrototype } from './ApiPrototype';
import { ClientFilterDefinition } from './ClientFilter';
import { ClientRequest } from './ClientRequest';
import { ClientErrorTranslator } from './ClientErrorTranslator';
import { HttpResponseDtoFactory } from './HttpResponseDtoFactory';
import { RequestOutcome } from './RequestOutcome';
import { RequestBodySerializer } from './RequestBodySerializer';
import { ResponseBodyReader } from './ResponseBodyReader';
import { NdjsonRequestStream } from './NdjsonRequestStream';
import { SseResponseStream } from './SseResponseStream';
import { StreamingCapabilityError } from './StreamingCapabilityError';
import { ByteReadableStream } from './ByteStream';

class OpenedStreamingTransport {
    constructor(
        readonly response: Response,
        readonly upload: NdjsonRequestStream,
    ) {}
}

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
     * — @webpieces/http-client-node takes the SSRF policy from an installed `ContextBaseUrlFilter` / `ContextFullUrlFilter`
     * that way, which keeps the one legitimate relaxation at the same construction site as the
     * decision to be re-pointable at all.
     */
    protected appFilters: ClientFilterDefinition[] = [];

    // Stateless + dependency-free, so the browser bundle keeps no DI on the fetch path.
    private readonly networkRejectClassifier = new NetworkRejectClassifier();

    // Same shape and same reason: stateless, so it is constructed here rather than injected.
    private readonly bodyReader = new ResponseBodyReader();

    /**
     * DTO -> wire bytes, in the encoding the endpoint declared. Stateless, so one instance per
     * client; see {@link RequestBodySerializer} for why it lives outside this class.
     */
    private readonly bodySerializer = new RequestBodySerializer();

    /**
     * fetch `Response` -> the transport-neutral {@link HttpResponseDto} the registered `ErrorTranslator`
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
            route.background,
        );
        return this.logApiCall.execute(info, requestDto, method);
    }

    /**
     * Reject, at bind time, an endpoint this environment cannot satisfy — e.g. a browser cannot
     * mint the OIDC token an @WpAuthOidc endpoint demands. Surfacing it here beats failing on the
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

    /** Whether fetch can read the response while its streaming request body remains open. */
    protected abstract supportsConcurrentDuplexFetch(): boolean;

    /** Environment-owned full-duplex transport after the shared filter chain has prepared it. */
    protected abstract sendStreamingTransport(
        request: ClientRequest,
        signal: AbortSignal,
        body: ByteReadableStream,
    ): Promise<Response>;

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

    /**
     * A settled response's headers -> the CALLER's context, so a value set by a callee travels UP the
     * call tree hop by hop without anything in between naming HTTP.
     *
     * Fires on EVERY settled call, ok or error, because an error response carries the diagnostic
     * headers you most want (which backend answered, why it was a cache miss). It does NOT fire when
     * the transport never produced a response at all — there is nothing to read.
     *
     * The default is a no-op. Where the context LIVES is environment-specific (node: the ambient
     * RequestContext; browser: the app-held store), so the two subclasses implement it and this class
     * stays free of both. `destination` is threaded through unchanged from the request that produced
     * this response: it is what decides whether a TRUSTED response key may be believed at all — see
     * {@link DestinationTrust.allows}.
     */
    protected acceptResponseContext(_headers: Headers, _destination: DestinationTrust): void {}

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

        const endpoints = getEndpoints(apiPrototype) || {};

        // apiName as the class name so client logs read "SaveApi.save", not "undefined.save"
        this.apiName = apiPrototype.name || 'UnknownApi';

        // Two endpoints on one method + path would dial the same URL; refuse the contract up front.
        RouteMetadataFactory.assertNoDuplicateRoutes(apiPrototype);

        this.routeMap = new Map<string, RouteMetadata>();
        for (const methodName of Object.keys(endpoints)) {
            // One shared factory joins and validates method/path/query/body metadata for every
            // transport, rather than letting each generated client reinterpret the decorators.
            const route = RouteMetadataFactory.create(apiPrototype, methodName);
            const authMeta = route.authMeta;
            this.assertEndpointSupported(authMeta, methodName);
            this.routeMap.set(methodName, route);
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
        const authMode = route.authMeta?.mode;
        // @WpAuthApiKey: the credential is a CUSTOMER-held key, and the header carrying it is the app's
        // ApiKeyHook's choice, so this client has nothing to send and the call is a guaranteed 401.
        if (authMode?.kind === 'apikey') {
            throw new Error(
                `${this.apiName}.${route.methodName} is @WpAuthApiKey('${authMode.regime}') — only the partner ` +
                    `holding that api key can call it, and the header carrying it is the app's ApiKeyHook's choice, ` +
                    `so a webpieces client has no credential to send.`,
            );
        }
        // @WpAuthWebhook is DELIBERATELY absent from this list. It used to be here, on the assumption
        // that the vendor is always somebody else — but `@WpAuthWebhook(name)` names a signing SCHEME,
        // not a direction, and for an OUTBOUND partner webhook WE are the vendor. The environment's
        // outbound-auth filter asks its bound signer to produce the signature, which is the exact
        // mirror of the inbound WebhookAuthCallback that verifies one.
    }

    /** One logical call: one lifecycle pair and log entry across all strategy attempts. */
    // webpieces-disable no-any-unknown -- request and response DTOs are erased at the proxy boundary
    async makeRequest(route: RouteMetadata, args: unknown[]): Promise<unknown> {
        this.refuseEndpointNoClientCanCall(route);
        if (route.streaming) return this.makeStreamingRequest(route, args);
        const mapped = HttpContractMapper.toWire(
            route.path,
            route.parameterBindings,
            route.bodyParameterIndex,
            args,
        );
        const logValue = mapped.body === undefined ? args : mapped.body;
        return this.execute(route, logValue, () => this.executeCall(route, args));
    }

    /** Open a typed stream without bypassing the ordinary context/auth/filter request pipeline. */
    // webpieces-disable no-any-unknown -- generated proxy arguments are runtime-validated here
    private async makeStreamingRequest(route: RouteMetadata, args: unknown[]): Promise<unknown> {
        if (!this.supportsConcurrentDuplexFetch()) {
            throw new StreamingCapabilityError(
                'browser',
                'Fetch request streaming is half-duplex and has no protocol-compatible full-duplex fallback.',
            );
        }
        const destination = this.responseStream(args);
        return this.execute(route, 'stream-open', () =>
            this.executeStreamingCall(route, destination),
        );
    }

    // webpieces-disable no-any-unknown -- generated proxy arguments are runtime-validated here
    private responseStream(args: unknown[]): ResponseStream<DtoValue> {
        const candidate = args[0];
        if (args.length !== 1 || typeof candidate !== 'object' || candidate === null) {
            throw new StreamTransportError(
                `${this.apiName} streaming methods require exactly one ResponseStream argument.`,
            );
        }
        // webpieces-disable no-any-unknown -- reflected method argument is narrowed by the method checks below
        const record = candidate as Record<string, unknown>;
        if (
            typeof record['event'] !== 'function' ||
            typeof record['fail'] !== 'function' ||
            typeof record['complete'] !== 'function' ||
            typeof record['onCancel'] !== 'function'
        ) {
            throw new StreamTransportError(
                `${this.apiName} streaming method argument does not implement ResponseStream.`,
            );
        }
        return candidate as ResponseStream<DtoValue>;
    }

    /** One streaming handshake. Subsequent events stay on this established transport. */
    private async executeStreamingCall(
        route: RouteMetadata,
        destination: ResponseStream<DtoValue>,
    ): Promise<RequestStream<DtoValue>> {
        this.onRequestStart(route);
        let response: Response | undefined;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- lifecycle reports the original handshake failure
        try {
            const requestStream = await CallRegistry.execute(
                this.apiClass,
                route.methodName,
                (timeoutMs: number) =>
                    CallDeadline.run(
                        timeoutMs,
                        new CallContext(this.apiName, route.methodName),
                        async (deadlineSignal: AbortSignal) => {
                            const result = await this.openStreamingTransport(
                                route,
                                destination,
                                deadlineSignal,
                            );
                            response = result.response;
                            return result.upload;
                        },
                    ),
                30_000,
            );
            this.readResponseContext(route, response);
            this.onRequestEnd(
                route,
                new RequestOutcome(true, response?.status ?? 0, response?.headers),
            );
            return requestStream;
        } catch (err: unknown) {
            const error = toError(err);
            this.readResponseContext(route, response);
            this.onRequestEnd(
                route,
                new RequestOutcome(false, response?.status ?? 0, response?.headers, error),
            );
            throw err;
        }
    }

    /**
     * Hand a settled response's headers to {@link acceptResponseContext}, with the SAME
     * {@link DestinationTrust} the request was built with. One private helper rather than the same
     * four lines on each of the four settle paths, because a path that forgot it would silently stop
     * propagating context upward with nothing failing.
     */
    private readResponseContext(route: RouteMetadata, response: Response | undefined): void {
        if (response === undefined) {
            return;
        }
        this.acceptResponseContext(
            response.headers,
            DestinationTrust.forAuthMode(route.authMeta?.mode),
        );
    }

    private async openStreamingTransport(
        route: RouteMetadata,
        destination: ResponseStream<DtoValue>,
        deadlineSignal: AbortSignal,
    ): Promise<OpenedStreamingTransport> {
        const metadata = route.streaming;
        if (!metadata) throw new StreamTransportError('Streaming metadata disappeared.');
        const request = await this.prepareStreamingRequest(route);
        const controller = new AbortController();
        deadlineSignal.addEventListener('abort', (): void => controller.abort(), { once: true });
        const upload = new NdjsonRequestStream(
            metadata,
            // webpieces-disable no-any-unknown -- AbortController accepts a platform-defined cancellation reason
            (reason?: unknown) => controller.abort(reason),
        );
        const response = await this.chain.execute(request, () =>
            this.sendStreamingOnce(request, controller.signal, upload.body),
        );
        if (!response.ok) {
            await upload.transportFailed(
                new StreamTransportError(
                    `Streaming handshake failed with HTTP ${response.status}.`,
                ),
            );
            await this.readResponse(response, route);
            throw new StreamTransportError('Streaming handshake was rejected.');
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('text/event-stream')) {
            const error = new StreamTransportError(
                `Streaming response requires text/event-stream, received '${contentType || 'missing'}'.`,
            );
            await upload.transportFailed(error);
            throw error;
        }
        void new SseResponseStream()
            .consume(response, destination, metadata, upload)
            .catch(() => undefined);
        return new OpenedStreamingTransport(response, upload);
    }

    /** Fresh filter-visible request metadata; the live request body is transport-owned. */
    private async prepareStreamingRequest(route: RouteMetadata): Promise<ClientRequest> {
        const baseUrl = await this.resolveBaseUrl();
        const headers = new Map<string, string>();
        headers.set('Content-Type', 'application/x-ndjson');
        headers.set('Accept', 'text/event-stream');
        const context = this.outboundContextHeaders(
            DestinationTrust.forAuthMode(route.authMeta?.mode),
        );
        for (const entry of context.entries()) headers.set(entry[0], entry[1]);
        return new ClientRequest(route, this.apiName, baseUrl, headers, undefined, undefined);
    }

    // webpieces-disable no-any-unknown -- response DTO is erased at the proxy boundary
    private async executeCall(route: RouteMetadata, args: unknown[]): Promise<unknown> {
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
                            const request = await this.prepareRequest(route, args);
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
            this.readResponseContext(route, response);
            this.onRequestEnd(
                route,
                new RequestOutcome(false, response?.status ?? 0, response?.headers, error),
            );
            throw err;
        }
        this.readResponseContext(route, response);
        this.onRequestEnd(
            route,
            new RequestOutcome(true, response?.status ?? 0, response?.headers),
        );
        return result;
    }

    /** Fresh mutable request for every attempt, including URL, headers, auth and body. */
    // webpieces-disable no-any-unknown -- request DTO is erased at the proxy boundary
    private async prepareRequest(route: RouteMetadata, args: unknown[]): Promise<ClientRequest> {
        const baseUrl = await this.resolveBaseUrl();
        const mapped = HttpContractMapper.toWire(
            route.path,
            route.parameterBindings,
            route.bodyParameterIndex,
            args,
        );
        const headers = new Map<string, string>();
        const body = this.bodySerializer.serialize(this.apiName, route, mapped.body, headers);
        const context = this.outboundContextHeaders(
            DestinationTrust.forAuthMode(route.authMeta?.mode),
        );
        for (const entry of context.entries()) headers.set(entry[0], entry[1]);
        return new ClientRequest(
            route,
            this.apiName,
            baseUrl,
            headers,
            body,
            mapped.body,
            mapped.path,
        );
    }

    /**
     * ONE transmission — the bottom of the filter chain, and the only place `fetch` is called.
     *
     * Everything it sends comes off the {@link ClientRequest} as the chain left it, so a filter's
     * edits to the url, the headers or the serialized body are exactly what goes on the wire. It may
     * run more than once for a single RPC when a filter follows a redirect.
     *
     * A network reject (offline, DNS, CORS preflight) is classified into a typed ApiConnectionError here (a
     * genuine bug passes through untouched) so that filters above see the same typed error the caller
     * will, rather than a raw platform reject.
     */
    private async sendOnce(request: ClientRequest, signal: AbortSignal): Promise<Response> {
        CallDeadline.throwIfAborted(signal);
        const options: RequestInit = {
            method: request.route.httpMethod,
            signal,
            headers: request.headersAsRecord(),
            redirect:
                request.route.responseType === 'full' || !request.followRedirects
                    ? 'manual'
                    : 'follow',
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

    /** Node fetch's streaming upload option. Browser callers are refused before reaching here. */
    private async sendStreamingOnce(
        request: ClientRequest,
        signal: AbortSignal,
        body: ByteReadableStream,
    ): Promise<Response> {
        CallDeadline.throwIfAborted(signal);
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- platform rejects are normalized below
        try {
            return await this.sendStreamingTransport(request, signal, body);
        } catch (err: unknown) {
            const error = toError(err);
            throw this.networkRejectClassifier.toNetworkError(error, request.url);
        }
    }

    /** Body consumption is inside the attempt deadline, including non-JSON error bodies. */
    // webpieces-disable no-any-unknown -- response DTO is erased at the proxy boundary
    private async readResponse(response: Response, route: RouteMetadata): Promise<unknown> {
        const callId = `${this.apiName}.${route.methodName}`;
        if (route.responseType === 'full') {
            return this.responseDtoFactory.fromFetch(
                response,
                await this.readFullResponseBody(response),
            );
        }
        // 266 is protocol success, but its body represents an expected user exception.
        if (response.ok && response.status !== 266) {
            if (!this.bodyReader.isJson(response)) {
                throw new Error(
                    this.bodyReader.describeForeignBody(response, callId, await response.text()),
                );
            }
            // webpieces-disable no-any-unknown -- a success body is the caller's own DTO, erased here
            const body: unknown = await response.json();
            // EVERY response passes the seam, 2xx included: an app whose 200 body signals failure
            // turns it into a throw here. The webpieces default returns silently, so the success
            // path is unchanged — and the body is parsed ONCE, because a fetch body reads once.
            ClientErrorTranslator.throwIfFailure(this.responseDtoFactory.fromFetch(response, body));
            return body;
        }
        const protocolError = await this.bodyReader.readErrorBody(response, callId);
        // The mirror of what the SERVER's `toWire` wrote. `fromWire` throws, so this method cannot
        // return for a failure response — `throwIfFailure` puts the webpieces default behind an app
        // translator that forgets to, so the guarantee does not depend on app code being correct.
        ClientErrorTranslator.throwFailure(
            this.responseDtoFactory.fromFetch(response, protocolError),
        );
    }

    /** Preserve empty, JSON, and protocol text bodies for caller-owned full responses. */
    // webpieces-disable no-any-unknown -- a full response deliberately preserves the caller-owned body
    private async readFullResponseBody(response: Response): Promise<unknown> {
        if (response.status === 204 || response.status === 304) return undefined;
        const text = await response.text();
        if (text === '') return undefined;
        if (!this.bodyReader.isJson(response)) return text;
        // webpieces-disable no-any-unknown -- parsed JSON is returned untouched to the typed contract caller
        return JSON.parse(text) as unknown;
    }
}
