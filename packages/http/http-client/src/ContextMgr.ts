import { ContextReader, HeaderMethods, HeaderRegistry } from '@webpieces/core-util';
import { RequestIdChainProcessor } from './RequestIdChainProcessor';

/**
 * ContextMgr - Manages context reader + header registry for HTTP clients.
 *
 * Passed to createApiClient() via ClientConfig.contextMgr to enable automatic
 * header propagation: every header in the registry with isWantTransferred=true
 * is read from the ContextReader and added to outbound requests.
 *
 * BREAKING (migration from the PlatformHeader[] constructor):
 *   new ContextMgr(reader, headerArray)
 * becomes
 *   new ContextMgr(reader, new HeaderRegistry([new PlatformHeadersExtension(headerArray)]))
 *
 * Example usage:
 * ```typescript
 * // Node.js server-side (reads the magic context from RequestContext):
 * const contextMgr = new ContextMgr(new RequestContextReader(), registry);
 *
 * // Browser client-side (app-managed store, no AsyncLocalStorage):
 * const store = new MutableContextStore();
 * const contextMgr = new ContextMgr(store, registry);
 *
 * // Both cases:
 * const config = new ClientConfig('http://api.example.com', contextMgr);
 * const client = createApiClient(SaveApi, config);
 * ```
 */
export class ContextMgr {
    private chainProcessor: RequestIdChainProcessor;

    constructor(
        /**
         * The context reader that provides header values.
         * Different implementations for Node.js vs browser.
         */
        public readonly contextReader: ContextReader,

        /**
         * The single source of truth for which headers exist and how they behave
         * (transferred/secured/MDC). Shared with the server-side filters.
         */
        public readonly registry: HeaderRegistry,

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
     * Build the headers to send on an outbound request: every transferred
     * header (isWantTransferred=true) with a non-empty value in the context,
     * then request-id chaining applied (unless opted out).
     *
     * Values are RAW (unmasked) - this map goes on the wire, not in logs.
     */
    buildOutboundHeaders(): Map<string, string> {
        const outbound = new Map<string, string>();

        for (const header of this.registry.getTransferredHeaders()) {
            const value = this.contextReader.read(header);
            if (value !== undefined && value !== null && value !== '') {
                outbound.set(header.headerName, value);
            }
        }

        if (this.chainRequestIds) {
            this.chainProcessor.process(outbound);
        }

        return outbound;
    }

    /**
     * Build the header map for LOGGING: secured header values are masked,
     * and headers are keyed by loggerMdcKey when defined.
     */
    buildHeadersForLogging(headerMethods: HeaderMethods): Map<string, string> {
        return headerMethods.buildSecureMapForLogs(this.registry.getHeaders(), this.contextReader);
    }
}
