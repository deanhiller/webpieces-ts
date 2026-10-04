import {
    ContextMgr,
    ClientRegistry,
    DestinationTrust,
    LogApiCallImpl,
    RouteMetadata,
    StreamDirection,
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
    protected override selectAuthMethod(route: RouteMetadata): import('@webpieces/core-util').AuthMode {
        const selected = route.authMeta?.methods.find((method: import('@webpieces/core-util').AuthMode) => method.kind === 'jwt' || method.kind === 'public');
        if (!selected) {
            const methods = route.authMeta?.methods.map((method: import('@webpieces/core-util').AuthMode) => method.kind === 'apikey' ? `apiKey('${method.regime}', credentials)` : method.kind).join(', ');
            throw new Error(`Endpoint ${route.apiName}.${route.methodName} declares ${methods}. A browser cannot hold these credentials; call it from a server-side client with the configured verifier credentials.`);
        }
        return selected;
    }
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
     * refuses to bind an oidc(...) / sharedSecret(...) contract, so every browser destination is
     * jwt() or @WpAuthPublic — which means a browser never puts a trusted context key on the wire. It is
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
     * Both service-to-service modes need credentials only a server has: oidc(...) needs a runtime
     * service account to mint a token, sharedSecret(...) needs a secret no browser may ship.
     *
     * @WpLocalOnly is deliberately NOT rejected: a browser calling a dev-only endpoint on the
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
    protected override assertEndpointSupported(route: RouteMetadata): void {
        const methodName = route.methodName;
        if (route.streaming && route.streaming.direction !== StreamDirection.RESPONSE) {
            throw new StreamingCapabilityError(
                'browser',
                `Browser Fetch supports only @WpStream(StreamDirection.RESPONSE); ${methodName} is ${route.streaming.direction}.`,
            );
        }
        this.selectAuthMethod(route);
    }
}
