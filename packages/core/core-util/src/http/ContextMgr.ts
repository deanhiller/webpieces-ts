import { ContextReader } from './ContextReader';
import { HeaderMethods } from './HeaderMethods';
import { HeaderRegistry } from './HeaderRegistry';
import { RequestIdChainProcessor } from './RequestIdChainProcessor';

/**
 * ContextMgr - propagates the magic context onto outbound HTTP requests.
 *
 * Passed to ClientHttpFactory's constructor: every transferred key (httpHeader set)
 * in the GLOBAL {@link HeaderRegistry} is read from the ContextReader and added to
 * outbound requests. The registry is a process global (configured once at startup,
 * like LogManager), so ContextMgr no longer takes a registry argument.
 *
 * Browser-safe (no AsyncLocalStorage): the server-side reader (RequestContextReader,
 * in @webpieces/core-context) and the browser store (MutableContextStore, in
 * @webpieces/http-client) both implement ContextReader.
 *
 * Example usage:
 * ```typescript
 * // Node.js server-side (reads the magic context from RequestContext):
 * const contextMgr = new ContextMgr(new RequestContextReader());
 *
 * // Browser client-side (app-managed store, no AsyncLocalStorage):
 * const contextMgr = new ContextMgr(new MutableContextStore());
 *
 * // Both cases — the ContextMgr is a factory dependency, the baseUrl is client state:
 * const factory = new ClientHttpFactory(contextMgr);
 * const client = factory.createClient(SaveApi, new ClientConfig('http://api.example.com'));
 * ```
 */
export class ContextMgr {
    private chainProcessor: RequestIdChainProcessor;
    private headerMethods: HeaderMethods = new HeaderMethods();

    constructor(
        /**
         * The context reader that provides context-key values.
         * Different implementations for Node.js vs browser.
         */
        public readonly contextReader: ContextReader,

        /**
         * When true (default), outbound calls send the current x-request-id as
         * x-previous-request-id (and drop x-request-id) so each hop in a
         * distributed trace gets its own id chained to its caller's.
         */
        public readonly chainRequestIds: boolean = true,
    ) {
        this.chainProcessor = new RequestIdChainProcessor();
    }

    /**
     * Build the headers to send on an outbound request: every transferred key
     * (httpHeader set) with a non-empty value in the context, emitted under its
     * `httpHeader` wire name, then request-id chaining applied (unless opted out).
     *
     * Values are RAW (unmasked) - this map goes on the wire, not in logs.
     */
    buildOutboundHeaders(): Map<string, string> {
        const outbound = new Map<string, string>();

        for (const key of HeaderRegistry.get().getTransferredKeys()) {
            const value = this.contextReader.read(key);
            if (value !== undefined && value !== null && value !== '') {
                outbound.set(key.httpHeader!, value);
            }
        }

        if (this.chainRequestIds) {
            this.chainProcessor.process(outbound);
        }

        return outbound;
    }

    /**
     * Build the header map for LOGGING: secured values masked, keyed by each key's
     * `name`, only for keys with isLogged=true.
     */
    buildHeadersForLogging(): Map<string, string> {
        return this.headerMethods.buildSecureMapForLogs(HeaderRegistry.get().getLoggedKeys(), this.contextReader);
    }
}
