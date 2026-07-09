import { ContextKey } from '../ContextKey';
import { ContextReader } from './ContextReader';
import { HeaderRegistry } from './HeaderRegistry';

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
 * HeaderRegistry.configure(AppHeaders.getAllHeaders(), CompanyHeaders.getAllHeaders(), true);
 *
 * const store = new MutableContextStore();
 * const factory = new ClientHttpBrowserFactory(store);
 * const client = factory.createClient(SaveApi, new ClientConfig('http://api.example.com'));
 * ```
 */
export class ContextMgr {

    constructor(
        /** The app-held store that provides context-key values. */
        public readonly contextReader: ContextReader,
    ) {}

    /**
     * Build the headers to send on an outbound request: every transferred key (httpHeader set)
     * with a non-empty value, emitted under its `httpHeader` wire name.
     *
     * NO request-id chaining. A browser ORIGINATES a trace — it has no inbound request to point
     * back at. If the app puts an `x-request-id` on the store it goes out as-is, and the server's
     * inbound transfer adopts it as hop 1's own id. Chaining is a server concern; see
     * RequestContextHeaders.
     *
     * Values are RAW (unmasked) — this map goes on the wire, not in logs.
     */
    buildOutboundHeaders(): Map<string, string> {
        const outbound = new Map<string, string>();

        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            const value = this.contextReader.read(key);
            if (value !== undefined && value !== null && value !== '') {
                outbound.set(key.httpHeader!, value);
            }
        }

        return outbound;
    }
}
