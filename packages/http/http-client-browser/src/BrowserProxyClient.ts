import { AuthMeta, ContextMgr, ClientRegistry, RouteMetadata } from '@webpieces/core-util';
import { ApiPrototype, ProxyClient, RequestOutcome } from '@webpieces/http-client-core';
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
        super();
    }

    /** Bind this client to one API contract + base URL. */
    init(apiPrototype: ApiPrototype<object>, config: ClientConfig): void {
        this.config = config;
        this.initRoutes(apiPrototype);
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

    protected override outboundHeaders(): Map<string, string> {
        return this.contextMgr.buildOutboundHeaders();
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
     * Both service-to-service modes need credentials only a server has: @AuthOidc needs a runtime
     * service account to mint a token, @AuthSharedSecret needs a secret no browser may ship.
     */
    protected override assertEndpointSupported(authMeta: AuthMeta | undefined, methodName: string): void {
        const kind = authMeta?.mode.kind;
        if (kind !== 'oidc' && kind !== 'shared-secret') {
            return;
        }
        throw new Error(
            `Endpoint ${methodName} is @${kind === 'oidc' ? 'AuthOidc' : 'AuthSharedSecret'} — a browser cannot ` +
            `hold service credentials. Call it server-side with ClientHttpFactory from @webpieces/http-client-node.`,
        );
    }
}
