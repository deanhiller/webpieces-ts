import { ContextKey } from '../ContextKey';
import { ContextReader } from './ContextReader';
import { DestinationTrust } from './DestinationTrust';
import { HeaderRegistry } from './HeaderRegistry';
import { ServiceInfo } from './ServiceInfo';
import { WebpiecesCoreHeaders } from './WebpiecesCoreHeaders';

/**
 * ContextMgr - propagates the magic context onto outbound BROWSER requests.
 *
 * BROWSER-ONLY. Only @webpieces/http-client-browser may name this class. The server reads
 * `RequestContext` directly through `RequestContextHeaders` (in @webpieces/core-context) — a
 * `ContextReader` indirection buys a server nothing, because there is exactly one right answer there.
 *
 * Browsers have no AsyncLocalStorage, so the app holds a `MutableContextStore` and sets values as
 * they become known (login token, tenant). Every transferred key (httpHeader set) in the GLOBAL
 * {@link HeaderRegistry} is read from it and added to outbound requests. The registry is a process
 * global configured once at startup (like LogManager) and is browser-safe: it is the key SCHEMA,
 * not the value store.
 *
 * Example usage:
 * ```typescript
 * // startup, before bootstrap:
 * HeaderRegistry.configure(CompanyHeaders.ALL_HEADERS, true);
 *
 * const store = new MutableContextStore();
 * const factory = new ClientHttpBrowserFactory(store);
 * const client = factory.createRpcClient(SaveApi, new ClientConfig('http://api.example.com'));
 * ```
 */
export class ContextMgr {

    constructor(
        /** The app-held store that provides context-key values. */
        public readonly contextReader: ContextReader,
    ) {}

    /**
     * Build the headers to send on an outbound request: every transferred key (httpHeader set)
     * with a non-empty value THAT THIS DESTINATION MAY RECEIVE, emitted under its `httpHeader`
     * wire name.
     *
     * NO request-id chaining. A browser ORIGINATES a trace — it has no inbound request to point
     * back at. If the app puts an `x-request-id` on the store it goes out as-is, and the server's
     * inbound transfer adopts it as hop 1's own id. Chaining is a server concern; see
     * RequestContextHeaders.
     *
     * `destination` gates TRUSTED keys exactly as it does on the server side (see
     * {@link DestinationTrust}). In practice a browser never reaches the permissive branch — twice
     * over: `BrowserProxyClient.assertEndpointSupported` refuses to bind an `@AuthOidc` /
     * `@AuthSharedSecret` contract at all, so every browser destination is `@AuthJwt` or `@Public`.
     * The rule is applied here anyway rather than argued away, because the OTHER guarantee people
     * reach for — "`MutableContextStore.set` only accepts an untrusted key, so a browser store
     * cannot HOLD a trusted value" — is true of that store and NOT of the seam: {@link ContextMgr}
     * takes any app-supplied {@link ContextReader}, whose `read` is handed an `AnyContextKey`. One
     * enforced rule in both builders beats a browser-only exemption resting on an implementation
     * detail of one implementation.
     *
     * Values are RAW (unmasked) — this map goes on the wire, not in logs.
     */
    buildOutboundHeaders(destination: DestinationTrust): Map<string, string> {
        const outbound = new Map<string, string>();

        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            if (!destination.allows(key)) {
                continue;
            }
            const value = this.contextReader.read(key);
            if (value !== undefined && value !== null && value !== '') {
                outbound.set(key.httpHeader!, value);
            }
        }

        // CLIENT_VERSION: a browser ORIGINATES a call, so it sends its OWN app build version (from
        // ServiceInfo) and the server logs which client build called it — same rule as the server-side
        // RequestContextHeaders. Our version wins; absent if this app was never identified via setInfo.
        const myVersion = ServiceInfo.getVersion();
        const clientVersionHeader = WebpiecesCoreHeaders.CLIENT_VERSION.httpHeader!;
        if (myVersion) {
            outbound.set(clientVersionHeader, myVersion);
        } else {
            outbound.delete(clientVersionHeader);
        }

        return outbound;
    }
}
