import { inject, optional } from 'inversify';
import { once } from 'node:events';
import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import {
    AuthMode,
    ClientRegistry,
    DestinationTrust,
    ApiImplementationError,
    RecordedEndpoint,
    RecordedError,
    LogApiCallImpl,
    RouteMetadata,
    Secrets,
    SECRETS,
    TestCaseRecorder,
    toError,
    ClientRole,
    HttpCallFactsHolder,
} from '@webpieces/core-util';
import {
    RequestContext,
    RequestContextApiCallContext,
    RequestContextHeaders,
    provideFrameworkTransient,
    VendorAuthMinter,
    VENDOR_AUTH_MINTER,
} from '@webpieces/core-context';
import { GcpOidc } from '@webpieces/gcp-identity';
import {
    ApiPrototype,
    ByteReadableStream,
    ClientRequest,
    ClientFilterDefinition,
    ProxyClient,
} from '@webpieces/http-client-core';
import { AddressResolver } from './AddressResolver';
import { ClientConfig } from './ClientConfig';
import { ContextBaseUrlFilter } from './ContextBaseUrlFilter';
import { ContextFullUrlFilter } from './ContextFullUrlFilter';
import { MissingClientCredentialError } from './OutboundAuthErrors';
import { OutboundAuthFilter } from './OutboundAuthFilter';
import { SsrfGuardFilter } from './SsrfGuardFilter';
import { SsrfPolicy } from './SsrfPolicy';

/**
 * The two framework built-ins' priorities, RELATIVE TO EACH OTHER and to nothing else — they are
 * ordered beneath every app filter structurally, not by number (see `ProxyClient.initRoutes`).
 *
 * The guard is OUTSIDE the minter deliberately: a destination that is going to be refused must be
 * refused BEFORE a credential is minted for it, so a hostile URL never causes a token to exist.
 */
const SSRF_GUARD_PRIORITY = 900;
const OUTBOUND_AUTH_PRIORITY = 800;

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
    /**
     * The declared method this client sends. ONE implementation, run at client creation by
     * {@link assertEndpointSupported} (which is what makes `createRpcClient` fail fast, #1362) and per
     * call by the base class — so the per-call run always finds what creation found, and there is no
     * "send an unsatisfiable `methods[0]` and let it fail later" fallback.
     *
     * A credential the FRAMEWORK can send now wins (the first in declaration order); otherwise a
     * credential the APP relays per call (a user JWT or a partner's api key, carried by a context key
     * or a client filter — see {@link appRelays}); otherwise nothing is sendable and creation fails.
     */
    protected override selectAuthMethod(route: RouteMetadata): AuthMode {
        const methods = route.authMeta?.methods;
        if (!methods) throw new Error('Endpoint requires @WpAuth or @WpAuthPublic.');
        const selected =
            methods.find((method: AuthMode) => this.frameworkSends(method)) ??
            methods.find((method: AuthMode) => NodeProxyClient.appRelays(method));
        if (selected) return selected;
        throw this.noSendableCredential(route, methods);
    }

    /**
     * ONE PER ENDPOINT (#1362): every route of the contract must declare at least one method this
     * client can send, or `createRpcClient` throws {@link MissingClientCredentialError}. Reads the bound
     * `Secrets` and the minter's pure `supportedVendorNames()` only — never mints, never refreshes, no network — and
     * never touches the inbound `VendorAuthVerifier`, so the #1358 construction cycle stays closed.
     */
    protected override assertEndpointSupported(route: RouteMetadata): void {
        this.selectAuthMethod(route);
    }

    /**
     * Can the FRAMEWORK send `method` from what this process holds NOW? An exhaustive switch with no
     * `default`, so a new AuthMode kind is a compile error here rather than silently sendable or not.
     */
    private frameworkSends(method: AuthMode): boolean {
        switch (method.kind) {
            case 'oidc':
            case 'public':
                return true;
            case 'shared-secret':
                return !!this.secrets?.get(method.secretKey);
            case 'vendorAuth':
                return this.vendorAuthMinter?.supportedVendorNames().includes(method.name) ?? false;
            // Never minted by the framework: see appRelays.
            case 'jwt':
            case 'apikey':
                return false;
        }
    }

    /**
     * A credential the framework never mints but the APP supplies PER CALL — a user JWT a node BFF
     * forwards from its own caller through a context key, a partner SDK's api-key headers set by a
     * client filter. Whether a given call carries it is unknowable at creation, exactly as for a
     * browser's JWT, so it is not refused here: a call without it is the callee's 401.
     */
    // webpieces-disable no-function-outside-class -- static pure predicate over the AuthMode union, kept beside its only caller
    private static appRelays(method: AuthMode): boolean {
        switch (method.kind) {
            case 'jwt':
            case 'apikey':
                return true;
            case 'oidc':
            case 'public':
            case 'shared-secret':
            case 'vendorAuth':
                return false;
        }
    }

    private noSendableCredential(route: RouteMetadata, methods: readonly AuthMode[]): MissingClientCredentialError {
        const endpoint = `${this.contractName()}.${route.methodName}`;
        const declared = methods.map((method: AuthMode) => NodeProxyClient.spell(method));
        const cures = methods.map((method: AuthMode) => `  - ${NodeProxyClient.spell(method)}: ${this.cureFor(method)}`);
        return new MissingClientCredentialError(
            `${endpoint} declares ${declared.join(', ')}, and this client can send none of them, so ` +
                `createRpcClient refuses the contract rather than fail on the first call. Make ONE of ` +
                `these sendable (a client needs only one):\n${cures.join('\n')}`,
            endpoint,
            declared,
        );
    }

    private cureFor(method: AuthMode): string {
        switch (method.kind) {
            case 'shared-secret':
                return this.secrets
                    ? `the bound Secrets (${this.secrets.constructor.name}) holds no value for '${method.secretKey}' — give it one`
                    : `bind a Secrets carrying '${method.secretKey}': binder.bind(SECRETS).to(YourSecrets).inSingletonScope();`;
            case 'vendorAuth':
                return this.vendorAuthMinter
                    ? `the bound VendorAuthMinter (${this.vendorAuthMinter.constructor.name}) supportedVendorNames() returns ` +
                          `[${this.vendorAuthMinter.supportedVendorNames().map((name: string) => `'${name}'`).join(', ')}] — add '${method.name}' to ` +
                          `supportedVendorNames() and handle it in mint()/refresh()`
                    : `bind the OUTBOUND role: binder.bind(VENDOR_AUTH_MINTER).to(YourVendorAuthMinter).inSingletonScope(); ` +
                          `(a VENDOR_AUTH_VERIFIER binding does not count: it verifies inbound calls and never sends)`;
            case 'jwt':
            case 'apikey':
                return 'relayed by the app per call';
            case 'oidc':
            case 'public':
                return 'always sendable';
        }
    }

    // webpieces-disable no-function-outside-class -- static pure formatter of the AuthMode union, kept beside its only callers
    private static spell(method: AuthMode): string {
        switch (method.kind) {
            case 'oidc': return method.callerScope === 'same-project' ? 'oidcSameProject()' : `oidcSvcs([${method.callers.join(', ')}])`;
            case 'public': return '@WpAuthPublic';
            case 'jwt': return 'jwt()';
            case 'shared-secret': return `sharedSecret('${method.secretKey}')`;
            case 'vendorAuth': return `vendorAuth('${method.name}')`;
            case 'apikey': return `apiKey('${method.regime}', credentials)`;
        }
    }

    private config!: ClientConfig;

    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(RequestContextHeaders) private readonly headers: RequestContextHeaders,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(AddressResolver) private readonly addressResolver: AddressResolver,
        // @optional: only sharedSecret(...) endpoints need it; the client sends its bound value.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional() @inject(SECRETS) private readonly secrets?: Secrets,
        // @optional: only OUTBOUND vendorAuth(...) calls need it, and createRpcClient refuses a contract
        // whose endpoint can be sent ONLY with a minter that is absent or does not list the vendor
        // (assertEndpointSupported) — see VendorAuthMinter. The OUTBOUND role ONLY: this
        // client must never depend on the server's inbound VendorAuthVerifier, because a verifier
        // that itself uses an RPC client would then close a construction cycle (#1358).
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional()
        @inject(VENDOR_AUTH_MINTER)
        private readonly vendorAuthMinter?: VendorAuthMinter,
    ) {
        // This package is node-only and already depends on core-context, so it builds the
        // RequestContext-backed ApiCallContext itself. No startup install, and therefore nothing a
        // non-webpieces host (plain NestJS/Express) can forget.
        super(new LogApiCallImpl(new RequestContextApiCallContext()));
    }

    /**
     * Bind this client to one API contract + target, with the app's outbound filters (url
     * rewriting, header editing, logging, per-call re-pointing).
     */
    init(
        apiPrototype: ApiPrototype<object>,
        config: ClientConfig,
        appFilters: ClientFilterDefinition[],
    ): void {
        this.config = config;
        this.initRoutes(apiPrototype, appFilters);
    }

    /**
     * The same chain every client runs — a ClientRegistry mapping, else the installed deriver — but
     * with NODE's fallback: THROW. A server has no "own origin" to fall back to the way a browser
     * does, so an unresolvable peer is a setup bug and must fail loudly (the error names the fixes).
     *
     * Resolved per call, never at construction, so building a client stays synchronous. Any metadata
     * read beneath a deriver is memoized process-wide, so only the first call pays.
     */
    protected override clientRole(): ClientRole {
        return this.config.role;
    }

    protected override resolveBaseUrl(): Promise<string> {
        return ClientRegistry.resolve(this.config.svcName);
    }

    /** Node/undici supports a live ReadableStream body when fetch is given `duplex: 'half'`. */
    protected override supportsConcurrentDuplexFetch(): boolean {
        return true;
    }

    /**
     * Node's native HTTP stream is genuinely concurrent: unlike browser Fetch, an early response
     * does not cancel the still-open upload. The returned Web Response keeps parsing isomorphic.
     */
    protected override sendStreamingTransport(
        request: ClientRequest,
        signal: AbortSignal,
        body: ByteReadableStream,
    ): Promise<Response> {
        return new Promise<Response>(
            (resolve: (response: Response) => void, reject: (error: Error) => void) => {
                const url = new URL(request.url);
                const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
                const outgoing = send(
                    url,
                    {
                        method: 'POST',
                        headers: request.headersAsRecord(),
                        signal,
                    },
                    (incoming: IncomingMessage): void => {
                        const headers = new Headers();
                        for (const [name, value] of Object.entries(incoming.headers)) {
                            if (Array.isArray(value)) {
                                for (const item of value) headers.append(name, item);
                            } else if (value !== undefined) {
                                headers.set(name, value);
                            }
                        }
                        const responseBody = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
                        resolve(
                            new Response(responseBody, {
                                status: incoming.statusCode ?? 500,
                                statusText: incoming.statusMessage,
                                headers,
                            }),
                        );
                    },
                );
                outgoing.once('error', reject);
                // webpieces-disable no-any-unknown -- a native socket/write rejection is normalized by toError
                void this.pumpStreamingRequest(body, outgoing).catch((err: unknown) => {
                    const error = toError(err);
                    outgoing.destroy(error);
                });
            },
        );
    }

    private async pumpStreamingRequest(
        body: ByteReadableStream,
        outgoing: import('node:http').ClientRequest,
    ): Promise<void> {
        const reader = body.getReader();
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- socket errors reject writer acknowledgements
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                if (!outgoing.write(part.value)) await once(outgoing, 'drain');
            }
            outgoing.end();
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * The two framework built-ins, installed on EVERY client this package builds and ordered
     * beneath every app filter by {@link ProxyClient.initRoutes}.
     *
     * They are unconditional rather than opt-in because neither costs anything on the path that
     * does not need it: the SSRF guard steps aside when nothing re-pointed the request, and the
     * auth filter does nothing for a `@WpAuthPublic` endpoint. An app therefore cannot forget to install
     * the guard on the one client that takes runtime URLs — the ACT of re-pointing is what arms it.
     */
    protected override clientFilters(): ClientFilterDefinition[] {
        return [
            new ClientFilterDefinition(
                SSRF_GUARD_PRIORITY,
                new SsrfGuardFilter(this.ssrfPolicy(), this.addressResolver),
            ),
            new ClientFilterDefinition(
                OUTBOUND_AUTH_PRIORITY,
                new OutboundAuthFilter(this.gcpOidc, this.secrets, this.vendorAuthMinter),
            ),
        ];
    }

    /**
     * WHICH policy the guard applies when something does re-point this client.
     *
     * Read off an installed {@link ContextBaseUrlFilter} or {@link ContextFullUrlFilter}, because
     * that filter is where an app says
     * "this client may be re-pointed", and the single legitimate relaxation
     * ({@link SsrfTestingPolicy}) belongs at the same construction site as that decision rather
     * than in a second place a reader has to correlate. No such filter — or one built with the
     * default — means {@link SsrfPolicy} (the strict one), so the safe answer is what an app gets by saying
     * nothing.
     */
    private ssrfPolicy(): SsrfPolicy {
        for (const definition of this.appFilters) {
            const filter = definition.filter;
            if (filter instanceof ContextBaseUrlFilter || filter instanceof ContextFullUrlFilter) {
                return filter.ssrfPolicy;
            }
        }
        return new SsrfPolicy();
    }

    /**
     * Straight from the RequestContext. Throws when there is no active request scope.
     *
     * `destination` rides through unchanged: this is the ONE client that can legitimately propagate a
     * verified identity, and it does so exactly when the callee will authenticate us (oidcSameProject() /
     * oidcSvcs(...) / sharedSecret(...)). Calling a peer's @WpAuthPublic or jwt() endpoint now omits `x-user-id` and
     * friends instead of shipping headers that endpoint's AuthFilter is obliged to reject.
     */
    protected override outboundContextHeaders(destination: DestinationTrust): Map<string, string> {
        return this.headers.buildOutboundHeaders(destination);
    }

    /**
     * Straight into the ambient RequestContext — the reason a value a callee set climbs the call
     * tree: after this returns, the CALLER's context holds it, and the caller's own response (and its
     * own outbound calls) carry it onward.
     *
     * `destination` is the trust gate, and it is the mirror of the inbound problem rather than a
     * restatement of it: a response is another process's ASSERTION. Untrusted response keys are
     * admitted; a TRUSTED one is admitted only from a destination this client authenticated to, and
     * is otherwise dropped — see `RequestContextHeaders.acceptResponseHeaders`.
     */
    protected override acceptResponseContext(
        headers: Headers,
        destination: DestinationTrust,
    ): void {
        this.headers.acceptResponseHeaders(headers, destination);
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
        http?: HttpCallFactsHolder,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    ): Promise<unknown> {
        // Preserve the context precondition before logging, which also requires an active scope.
        if (!RequestContext.isActive()) {
            throw new Error(
                'No active RequestContext. Run the client call inside RequestContext.run(...).',
            );
        }
        const recorder = this.headers.findRecorder();
        if (!recorder) {
            return super.execute(route, requestDto, method, http);
        }
        return this.recordCall(recorder, route, requestDto, method, http);
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
        http: HttpCallFactsHolder | undefined,
        // webpieces-disable no-any-unknown -- DTO types are erased at the proxy boundary
    ): Promise<unknown> {
        const ctxSnapshot: Record<string, string> = {};
        for (const entry of RequestContext.buildLogFields().entries()) {
            ctxSnapshot[entry[0]] = entry[1];
        }
        const recorded = new RecordedEndpoint(
            this.contractName(),
            route.methodName,
            [requestDto],
            ctxSnapshot,
        );
        recorder.addEndpointInfo(recorded);

        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- capture failure into the recording, then rethrow unchanged
        try {
            const response = await super.execute(route, requestDto, method, http);
            recorded.successResponse = response;
            return response;
        } catch (err: unknown) {
            const error = toError(err);
            recorded.failureResponse = new RecordedError(error.name, error.message);
            throw err;
        }
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
