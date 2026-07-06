import { PlatformHeader, ContextReader } from '@webpieces/core-util';
import { ContextKey } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * RequestContextReader - Reads headers from Node.js RequestContext.
 *
 * Only works in Node.js with active AsyncLocalStorage context.
 * This is a server-side only implementation.
 *
 * Lives in @webpieces/core-context (Node.js only) alongside the RequestContext
 * (AsyncLocalStorage) it reads from, so libraries can build a context-propagating
 * ContextMgr without pulling in @webpieces/http-routing.
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
