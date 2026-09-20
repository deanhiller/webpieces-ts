import { inject, optional } from 'inversify';
import { once } from 'node:events';
import { request as httpRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import {
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
} from '@webpieces/core-util';
import {
    RequestContext,
    RequestContextApiCallContext,
    RequestContextHeaders,
    provideFrameworkTransient,
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
import { OutboundAuthFilter } from './OutboundAuthFilter';
import { SsrfGuardFilter } from './SsrfGuardFilter';
import { SsrfPolicy } from './SsrfPolicy';
import { WEBHOOK_SIGNER_CALLBACK, WebhookSignerCallback } from './WebhookSignerCallback';

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
    private config!: ClientConfig;

    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(RequestContextHeaders) private readonly headers: RequestContextHeaders,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(AddressResolver) private readonly addressResolver: AddressResolver,
        // @optional: only @WpAuthSharedSecret endpoints need it; the client sends its bound value.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional() @inject(SECRETS) private readonly secrets?: Secrets,
        // @optional: only @WpAuthWebhook endpoints need it, and an unbound one makes them THROW
        // rather than deliver unsigned — see WebhookSignerCallback.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional()
        @inject(WEBHOOK_SIGNER_CALLBACK)
        private readonly webhookSigner?: WebhookSignerCallback,
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
                new OutboundAuthFilter(this.gcpOidc, this.secrets, this.webhookSigner),
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
     * verified identity, and it does so exactly when the callee will authenticate us (@WpAuthOidc /
     * @WpAuthSharedSecret). Calling a peer's @WpAuthPublic or @WpAuthJwt endpoint now omits `x-user-id` and
     * friends instead of shipping headers that endpoint's AuthFilter is obliged to reject.
     */
    protected override outboundContextHeaders(destination: DestinationTrust): Map<string, string> {
        return this.headers.buildOutboundHeaders(destination);
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
        // Preserve the context precondition before logging, which also requires an active scope.
        if (!RequestContext.isActive()) {
            throw new Error(
                'No active RequestContext. Run the client call inside RequestContext.run(...).',
            );
        }
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
        const recorded = new RecordedEndpoint(
            this.contractName(),
            route.methodName,
            [requestDto],
            ctxSnapshot,
        );
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
