import {
    AuthMeta,
    ContextMgr,
    ClientRegistry,
    DestinationTrust,
    LogApiCallImpl,
    RouteMetadata,
} from '@webpieces/core-util';
import { BrowserApiCallContext } from './BrowserApiCallContext';
import {
    ApiPrototype,
    ByteReadableStream,
    ClientRequest,
    ProxyClient,
    RequestOutcome,
    StreamingCapabilityError,
} from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';
import { RequestLifecycleListener } from './RequestLifecycleListener';

/**
 * The browser {@link ProxyClient}. Reads context from the app-held store (via {@link ContextMgr}),
 * because a browser has no ambient request scope.
 *
 * It attaches NO outbound credential and does NO recording — both inherit the base's no-ops. A
 * browser cannot mint an OIDC token and must never hold a shared secret; the user's JWT travels as
 * an ordinary transferred context key, set on the store at login.
 *
 * This is the ONLY class in webpieces that names ContextMgr.
 */
export class BrowserProxyClient extends ProxyClient {
    private config!: ClientConfig;

    constructor(
        private readonly contextMgr: ContextMgr,
        private readonly lifecycleListener?: RequestLifecycleListener,
    ) {
        // The browser's ApiCallContext, constructed here rather than installed at startup: its store
        // is static, so every instance stamps into the one slot BrowserApiCallContext.snapshot()
        // reads — which is how a browser logger folds the `api` tag into each line.
        super(new LogApiCallImpl(new BrowserApiCallContext()));
    }

    /** Bind this client to one API contract + base URL. */
    init(apiPrototype: ApiPrototype<object>, config: ClientConfig): void {
        this.config = config;
        // The browser factory does not take app filters yet, so this client runs the framework
        // built-ins only (today: none). The chain itself is isomorphic and ready for them.
        this.initRoutes(apiPrototype, []);
    }

    /**
     * The same chain every client runs — a ClientRegistry mapping, else the installed deriver — but
     * with the BROWSER's fallback: `''`, which makes the URL RELATIVE (`/auth/oauth`) and therefore
     * same-origin, by definition. A browser app almost always calls the backend that served it, so
     * that is the default, and an unregistered svcName must NEVER throw the way it used to — a
     * forgotten registration silently killed sign-in, the request never leaving the page.
     *
     * A mapping still wins, which is exactly how an Angular dev server on :4201 reaches its backend
     * on :8201, while the same bundle served BY that backend in prod registers nothing and goes
     * relative. No `window` access, so this stays SSR-safe and testable.
     */
    protected override async resolveBaseUrl(): Promise<string> {
        return (await ClientRegistry.tryResolve(this.config.svcName)) ?? '';
    }

    /** Browser Fetch request streaming is specified as half-duplex, not concurrent duplex. */
    protected override supportsConcurrentDuplexFetch(): boolean {
        return false;
    }

    protected override sendStreamingTransport(
        _request: ClientRequest,
        _signal: AbortSignal,
        _body: ByteReadableStream,
    ): Promise<Response> {
        return Promise.reject(
            new StreamingCapabilityError(
                'browser',
                'Fetch request streaming is half-duplex and has no safe bidirectional fallback.',
            ),
        );
    }

    /**
     * `destination` is always the un-verifying kind here — {@link assertEndpointSupported} below
     * refuses to bind an @WpAuthOidc / @WpAuthSharedSecret contract, so every browser destination is
     * @WpAuthJwt or @WpAuthPublic — which means a browser never puts a trusted context key on the wire. It is
     * still threaded rather than short-circuited: the rule lives in ContextMgr, one place, for both
     * environments.
     */
    protected override outboundContextHeaders(destination: DestinationTrust): Map<string, string> {
        return this.contextMgr.buildOutboundHeaders(destination);
    }

    /**
     * Into the app-held store, via the same {@link ContextMgr} that owns the outbound direction — so
     * a value a server set reaches the page without the page naming a header.
     *
     * TRUSTED response keys are dropped there, by type: a browser store holds only untrusted values.
     * `destination` is threaded anyway rather than short-circuited here, for the reason the outbound
     * direction gives — the rule lives in ContextMgr, one place, for both environments.
     */
    protected override acceptResponseContext(
        headers: Headers,
        destination: DestinationTrust,
    ): void {
        this.contextMgr.acceptResponseHeaders(headers, destination);
    }

    /**
     * Forward the call's lifecycle to the app's listener, if one was registered on the factory. The
     * optional chain makes both a no-op when no listener is present — the default browser case.
     */
    protected override onRequestStart(route: RouteMetadata): void {
        this.lifecycleListener?.onRequestStart(route);
    }

    protected override onRequestEnd(route: RouteMetadata, outcome: RequestOutcome): void {
        this.lifecycleListener?.onRequestEnd(route, outcome);
    }


    /**
     * Reject a contract this browser cannot satisfy, at bind time rather than on the first call.
     * Both service-to-service modes need credentials only a server has: @WpAuthOidc needs a runtime
     * service account to mint a token, @WpAuthSharedSecret needs a secret no browser may ship.
     *
     * @WpAuthLocalOnly is deliberately NOT rejected: a browser calling a dev-only endpoint on the
     * developer's own server is the motivating case for that mode (shipping browser logs into the
     * server log). It needs no credential — the server refuses it off-local by not having the route.
     *
     * An exhaustive switch with NO `default`, like {@link DestinationTrust.forAuthMode} and
     * `AuthFilter.verifiesCaller`. This was a NEGATIVE allow-list (`kind !== 'oidc' && kind !==
     * 'shared-secret'`), which silently WAVED THROUGH any future AuthMode kind — the browser would
     * have bound a contract it cannot satisfy and failed on the first call instead of at bind time.
     * Adding `local-only` is what surfaced it: the third reader of the union should fail to compile
     * on a NEW kind for the same reason the other two do.
     */
    protected override assertEndpointSupported(
        authMeta: AuthMeta | undefined,
        methodName: string,
    ): void {
        const mode = authMeta?.mode;
        if (mode === undefined) {
            return;
        }
        switch (mode.kind) {
            case 'public':
            case 'jwt':
            case 'local-only':
                return;
            case 'oidc':
            case 'shared-secret':
                throw new Error(
                    `Endpoint ${methodName} is @${mode.kind === 'oidc' ? 'WpAuthOidc' : 'WpAuthSharedSecret'} — a browser ` +
                        `cannot hold service credentials. Call it server-side with ClientHttpFactory from ` +
                        `@webpieces/http-client-node.`,
                );
            // @WpAuthWebhook is not "a credential a browser lacks" — it is an endpoint whose ONLY
            // legitimate caller is the outside vendor that signs the request in its own scheme.
            // NOTHING in this repo can call it, browser or server, so it is refused at bind time
            // rather than failing as a 401 on the first call.
            case 'webhook':
                throw new Error(
                    `Endpoint ${methodName} is @WpAuthWebhook('${mode.name}') — only ${mode.name} can call it, ` +
                        `because only ${mode.name} can produce the signature its WebhookAuthCallback verifies. It is not ` +
                        `callable from a webpieces client.`,
                );
            // @WpAuthApiKey is the same shape of refusal for a different reason: the credential is a
            // CUSTOMER-held api key whose header names the app's ApiKeyHook chooses, so no webpieces
            // client knows what to send — and a browser must not ship a customer's key at all.
            case 'apikey':
                throw new Error(
                    `Endpoint ${methodName} is @WpAuthApiKey('${mode.regime}') — its credential is a customer-held ` +
                        `api key that a browser must never ship, and the header carrying it is the app's ApiKeyHook's ` +
                        `choice, so no webpieces client can build the call. Only the partner holding the key calls it.`,
                );
        }
    }
}
