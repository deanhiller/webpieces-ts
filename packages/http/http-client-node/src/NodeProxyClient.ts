import { inject, injectable, optional } from 'inversify';
import {
    AuthMeta,
    RecordedEndpoint,
    RecordedError,
    RouteMetadata,
    Secrets,
    TestCaseRecorder,
    toError,
} from '@webpieces/core-util';
import { RequestContext, RequestContextHeaders, provideFrameworkTransient } from '@webpieces/core-context';
import { GcpOidc, resolveTargetUrl } from '@webpieces/gcp-identity';
import { ApiPrototype, ProxyClient } from '@webpieces/http-client-core';
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
@injectable()
export class NodeProxyClient extends ProxyClient {
    private config!: ClientConfig;

    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(RequestContextHeaders) private readonly headers: RequestContextHeaders,
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
        // @optional: only @AuthSharedSecret endpoints need it; the client sends its bound value.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @optional() @inject(Secrets) private readonly secrets?: Secrets,
    ) {
        super();
    }

    /** Bind this client to one API contract + target. */
    init(apiPrototype: ApiPrototype<object>, config: ClientConfig): void {
        this.config = config;
        this.initRoutes(apiPrototype);
    }

    /**
     * Resolved per call, never at construction, so building a client stays synchronous. Every GCP
     * metadata read beneath resolveTargetUrl is memoized process-wide, so only the first call pays.
     */
    protected override resolveBaseUrl(): Promise<string> {
        return resolveTargetUrl(this.config.svcName, this.config.targetUrl);
    }

    /** Straight from the RequestContext. Throws when there is no active request scope. */
    protected override outboundHeaders(): Map<string, string> {
        return this.headers.buildOutboundHeaders();
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
