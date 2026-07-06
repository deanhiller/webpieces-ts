import { PlatformHeader, ContextReader } from '@webpieces/core-util';
import { ContextKey } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';

/**
 * RequestContextReader - Reads headers from Node.js RequestContext.
 *
 * Only works in Node.js with active AsyncLocalStorage context.
 * This is a server-side only implementation.
 *
 * NOTE: This class is in @webpieces/http-routing (Node.js only) instead of
 * @webpieces/http-client (cross-platform) because it has a hard dependency
 * on @webpieces/core-context which uses Node.js AsyncLocalStorage.
 *
 * For browser environments, use StaticContextReader from @webpieces/http-client.
 */
export class RequestContextReader implements ContextReader {
    /**
     * Read a header value from the active RequestContext.
     *
     * @param header - The platform header to read
     * @returns The header value, or undefined if not in context
     */
    read(header: PlatformHeader): string | undefined {
        // Use RequestContext.getHeader() which calls header.getHeaderName()
        return RequestContext.getHeader(header);
    }

    /**
     * Read a non-header context value (e.g. the active TestCaseRecorder under
     * RecorderKeys.RECORDER). Lets the isomorphic http-client find server-side
     * context without importing core-context itself.
     */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (recorder, meta objects)
    readValue(key: ContextKey): unknown {
        return RequestContext.getHeader(key);
    }
}
