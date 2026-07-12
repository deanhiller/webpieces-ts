import { AuthMeta, ContextMgr, ClientRegistry } from '@webpieces/core-util';
import { ApiPrototype, ProxyClient } from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';

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

    constructor(private readonly contextMgr: ContextMgr) {
        super();
    }

    /** Bind this client to one API contract + base URL. */
    init(apiPrototype: ApiPrototype<object>, config: ClientConfig): void {
        this.config = config;
        this.initRoutes(apiPrototype);
    }

    protected override resolveBaseUrl(): Promise<string> {
        // A browser cannot derive a GCP URL, so it resolves purely via the registry, which the app
        // populates at startup (per environment). lookup() throws if the svcName was not registered.
        return Promise.resolve(ClientRegistry.lookup(this.config.svcName));
    }

    protected override outboundHeaders(): Map<string, string> {
        return this.contextMgr.buildOutboundHeaders();
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
