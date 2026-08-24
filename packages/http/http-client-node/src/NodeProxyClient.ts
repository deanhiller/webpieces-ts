import { inject, optional } from 'inversify';
import {
    AuthMeta,
    ClientRegistry,
    DestinationTrust,
    HttpInternalServerError,
    RecordedEndpoint,
    RecordedError,
    RouteMetadata,
    Secrets,
    SECRETS,
    TestCaseRecorder,
    toError,
} from '@webpieces/core-util';
import { RequestContext, RequestContextHeaders, provideFrameworkTransient } from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import { ApiPrototype, ProxyClient, TranslatedFailure } from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';

/**
 * The server-side {@link ProxyClient}. Everything a browser cannot do lives here: reading the
 * ambient RequestContext, minting OIDC tokens, holding shared secrets, and recording test cases.
 *
 * TRANSIENT on purpose. Every `createRpcClient(api, config)` needs its own instance, because `init()`
 * binds one instance to exactly one API contract and one target. {@link ProxyClientProvider} hands
 * them out — see its doc.
 */
@provideFrameworkTransient()
export class NodeProxyClient extends ProxyClient {
    private config!: ClientConfig;

    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(RequestContextHeaders) private readonly headers: RequestContextHeaders,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
        // @optional: only @AuthSharedSecret endpoints need it; the client sends its bound value.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional() @inject(SECRETS) private readonly secrets?: Secrets,
    ) {
        super();
    }

    /** Bind this client to one API contract + target. */
    init(apiPrototype: ApiPrototype<object>, config: ClientConfig): void {
        this.config = config;
        this.initRoutes(apiPrototype);
    }

    /**
     * The same chain every client runs — a ClientRegistry mapping, else the installed deriver — but
     * with NODE's fallback: THROW. A server has no "own origin" to fall back to the way a browser
     * does, so an unresolvable peer is a setup bug and must fail loudly (the error names the fixes).
     *
     * Resolved per call, never at construction, so building a client stays synchronous. Any metadata
     * read beneath a deriver is memoized process-wide, so only the first call pays.
     */
    protected override resolveBaseUrl(): Promise<string> {
        return ClientRegistry.resolve(this.config.svcName);
    }

    /**
     * Straight from the RequestContext. Throws when there is no active request scope.
     *
     * `destination` rides through unchanged: this is the ONE client that can legitimately propagate a
     * verified identity, and it does so exactly when the callee will authenticate us (@AuthOidc /
     * @AuthSharedSecret). Calling a peer's @Public or @AuthJwt endpoint now omits `x-user-id` and
     * friends instead of shipping headers that endpoint's AuthFilter is obliged to reject.
     */
    protected override outboundContextHeaders(destination: DestinationTrust): Map<string, string> {
        return this.headers.buildOutboundHeaders(destination);
    }

    /**
     * Attach the outbound credential for the endpoint's AuthMode: an @AuthOidc bearer minted as
     * this caller's runtime SA (audience = the callee base URL — the server verifies the signature
     * + caller allow-list), or the @AuthSharedSecret(key) value THIS client sends from its bound
     * {@link Secrets}. Both ride in the ONE `Authorization` header under their own scheme —
     * `Bearer <oidc>` / `Webpieces <secret>` — which is never a context key, so it cannot leak onto
     * the next hop. Never reads process.env.
     */
    protected override async attachOutboundAuth(
        route: RouteMetadata,
        baseUrl: string,
        httpHeaders: Record<string, string>,
    ): Promise<void> {
        const mode = route.authMeta?.mode;
        if (mode?.kind === 'oidc') {
            httpHeaders['Authorization'] = `Bearer ${await this.gcpOidc.mintIdToken(baseUrl)}`;
        } else if (mode?.kind === 'shared-secret') {
            const secret = this.secrets?.get(mode.secretKey);
            if (!secret) {
                throw new Error(
                    `No shared secret configured for @AuthSharedSecret('${mode.secretKey}') endpoint ${route.methodName}`,
                );
            }
            // Same header as a JWT/OIDC token, but its OWN scheme, so a secret can never be
            // mistaken for a token nor accepted where one was expected.
            httpHeaders['Authorization'] = `Webpieces ${secret}`;
        }
    }

    /**
     * Test-case recording hook (mirror of Java HttpsJsonClientInvokeHandler): if a recorder is
     * travelling in the magic context, capture this outbound call + its result so it becomes a mock
     * in the generated test. Absent a recorder this is exactly the base behavior.
     */
    // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    protected override async execute(
        route: RouteMetadata,
        requestDto: unknown,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
        method: () => Promise<unknown>,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    ): Promise<unknown> {
        const recorder = this.headers.findRecorder();
        if (!recorder) {
            return super.execute(route, requestDto, method);
        }
        return this.recordCall(recorder, route, requestDto, method);
    }

    /**
     * Execute the call while recording it (args + masked ctx snapshot + result).
     *
     * The snapshot is a FIXTURE field, not a log line, so it is built here rather than handed down
     * from the call path — a logging backend stamps its own fields and never sees this.
     */
    // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    private async recordCall(
        recorder: TestCaseRecorder,
        route: RouteMetadata,
        requestDto: unknown,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
        method: () => Promise<unknown>,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    ): Promise<unknown> {
        const ctxSnapshot: Record<string, string> = {};
        for (const entry of RequestContext.buildLogFields().entries()) {
            ctxSnapshot[entry[0]] = entry[1];
        }
        const recorded = new RecordedEndpoint(this.contractName(), route.methodName, [requestDto], ctxSnapshot);
        recorder.addEndpointInfo(recorded);

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- capture failure into the recording, then rethrow unchanged
        try {
            const response = await super.execute(route, requestDto, method);
            recorded.successResponse = response;
            return response;
        } catch (err: unknown) {
            const error = toError(err);
            recorded.failureResponse = new RecordedError(error.name, error.message);
            throw err;
        }
    }

    /** A server can satisfy every auth mode, so nothing is rejected at bind time. */
    protected override assertEndpointSupported(_authMeta: AuthMeta | undefined, _methodName: string): void {}

    /**
     * SERVER-TO-SERVER: a 4xx received from a dependency becomes THIS server's own 500.
     *
     * THE INVARIANT:
     *
     *   A status received from a downstream dependency describes OUR request to it. It is never the
     *   status we return to OUR caller. The server that answered 404 is correct; the server that
     *   asked for a route that does not exist is broken, and must say so as a 500.
     *
     * Every 4xx is a CALLER-side defect on this hop: 404 = wrong path / wrong base URL / a dependency
     * that is not deployed yet, 400 = we sent a malformed request, 401/403 = our service credentials
     * or the callee's caller allow-list are wrong. None of them is an answer for whoever called US, and
     * relaying one lets an internal misconfiguration impersonate a legitimate response. That is not
     * hypothetical: a partner-facing Management API reported an EMPTY store estate for an org with six
     * live storefronts, because its dependency had not been promoted and Express served an HTML 404
     * which arrived here as `HttpNotFoundError` and went straight back out. A 500 would have been
     * loud, correct, and attributable to the one server that actually had the bug — which is the whole
     * point: only ONE server should be paged for this.
     *
     * DELIBERATELY 4xx ONLY. 5xx (502/503/504) already mean "the dependency is unavailable", which is
     * honest and useful outward, and 500 is already a 500. `HttpUserError` (266, a 2xx code carrying
     * user validation) and `HttpVendorError` (598) are not statuses about our request at all. All of
     * them pass through untouched.
     *
     * THE OPT-OUT IS `appRegistered`, not a config key. A thin proxy or gateway that genuinely wants to
     * relay a downstream status as its own registers a `ClientRegistry` error translation for it at
     * startup — one greppable line saying so out loud — and that translation wins here. Only the
     * framework's built-in default mapping gets wrapped. There is no flag, because a flag would make
     * the dangerous choice invisible in the code that suffers from it.
     *
     * The downstream diagnostic is NOT lost: the original error (which for the incident above names the
     * method, the status, the `text/html` content-type and a snippet of the body) is both quoted in the
     * message and kept as `httpCause`.
     *
     * How much "Downstream said:" is worth depends on WHO answered, and both halves are by design:
     * - a NON-webpieces answer (an lb's html 404, a proxy's plain-text 502) is described CLIENT-side by
     *   `ResponseBodyReader.describeForeignBody`, so the full diagnostic is ours to quote — this is the
     *   mealco incident's exact shape, and it is the case that mattered.
     * - a WEBPIECES peer deliberately sends only the generic reason phrase for its status (see
     *   `HttpErrorWireMapper` in http-server — only `HttpUserError`'s message is caller-facing), so this
     *   reads "Downstream said: Not Found". That is correct and not a regression: the peer's real
     *   message is in the PEER's log, correlated by request id, which is the only place it was ever
     *   safe to read it.
     *
     * This whole string is an operator-facing message on an `HttpInternalServerError`, so when THIS
     * server answers its own caller none of it goes on the wire — it goes to this server's log.
     */
    protected override adaptDownstreamFailure(failure: TranslatedFailure, callId: string): Error {
        if (failure.appRegistered) {
            return failure.error;
        }
        if (failure.statusCode < 400 || failure.statusCode >= 500) {
            return failure.error;
        }
        return new HttpInternalServerError(
            `${callId}: dependency answered HTTP ${failure.statusCode}. That status describes OUR ` +
            `request to it, not an answer for our caller, so this server owns it as a 500 — check the ` +
            `path, the base URL, whether the dependency is deployed, and our service credentials. ` +
            `Downstream said: ${failure.error.message}`,
            failure.error,
        );
    }
}

/**
 * DI token for the `Provider<NodeProxyClient>` that hands out RPC clients — one per API contract.
 * `Provider<T>` is erased at runtime, so it cannot be its own token; this Symbol names T.
 *
 * Because NodeProxyClient is bound TRANSIENT, every `get()` constructs a new one. (Were it bound
 * `@provideFrameworkSingleton`, the very same Provider would instead hand back one lazily-created
 * instance — the provider caches nothing, so the target's scope decides.)
 */
// webpieces-disable no-symbol-di-tokens -- Provider<T> is erased at runtime; the Symbol names T
export const NODE_PROXY_CLIENT_PROVIDER = Symbol.for('Provider<NodeProxyClient>');
