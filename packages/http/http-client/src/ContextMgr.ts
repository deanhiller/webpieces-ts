import { PlatformHeader, ContextReader } from '@webpieces/http-api';

/**
 * ContextMgr - Manages context reader and header set for HTTP clients.
 *
 * Passed to createClient() via ClientConfig to enable automatic header propagation.
 * Combines a ContextReader (how to read header values) with a header set
 * (which headers to propagate).
 *
 * Example usage:
 * ```typescript
 * // Node.js server-side (reads from RequestContext)
 * const contextMgr = new ContextMgr(
 *     new RequestContextReader(),
 *     [...WebpiecesCoreHeaders.getAllHeaders(), ...CompanyHeaders.getAllHeaders()]
 * );
 *
 * // Browser client-side (reads from static map)
 * const headers = new Map([['Authorization', getToken()]]);
 * const contextMgr = new ContextMgr(
 *     new StaticContextReader(headers),
 *     [WebpiecesCoreHeaders.REQUEST_ID]
 * );
 *
 * // Both cases
 * const config = new ClientConfig('http://api.example.com', contextMgr);
 * const client = createClient(SaveApiPrototype, config);
 * ```
 */
export class ContextMgr {
    constructor(
        /**
         * The context reader that provides header values.
         * Different implementations for Node.js vs browser.
         */
        public readonly contextReader: ContextReader,

        /**
         * The set of platform headers to read and propagate.
         * Only headers in this set will be added to requests.
         */
        public readonly headerSet: PlatformHeader[]
    ) {}

    /**
     * Read a single header value by header name.
     *
     * Returns undefined if:
     * - Header name not found in headerSet
     * - Header has isWantTransferred=false
     * - contextReader returns undefined/null/empty string
     *
     * This method is called by ClientFactory for each header in the headerSet,
     * allowing a single loop instead of the previous double-loop pattern.
     *
     * @param headerName - The HTTP header name (e.g., 'x-request-id')
     * @returns The header value, or undefined if not available/transferable
     */
    read(headerName: string): string | undefined {
        // Find the header definition in our set
        const header = this.headerSet.find(h => h.headerName === headerName);

        // Not in our header set - don't transfer
        if (!header) {
            return undefined;
        }

        // Header not marked for transfer - don't transfer
        if (!header.isWantTransferred) {
            return undefined;
        }

        // Read value from context reader
        const value = this.contextReader.read(header);

        // Only return non-empty values
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }

        return undefined;
    }
}
