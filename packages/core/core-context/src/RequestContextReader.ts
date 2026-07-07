import { ContextKey, ContextReader } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * RequestContextReader - the NODE/server ContextReader. Reads context-key values
 * from the AsyncLocalStorage-backed RequestContext.
 *
 * Only works in Node.js with an active RequestContext. Lives in
 * @webpieces/core-context (Node-only) alongside the RequestContext it reads from,
 * so libraries can build a context-propagating ContextMgr without pulling in
 * @webpieces/http-routing.
 *
 * For browsers, use MutableContextStore from @webpieces/http-client.
 */
export class RequestContextReader implements ContextReader {
    /** Read a string context-key value from the active RequestContext. */
    read(key: ContextKey): string | undefined {
        return RequestContext.getHeader<string>(key);
    }

    /**
     * Read a non-string context value (e.g. the active TestCaseRecorder under
     * RecorderKeys.RECORDER). Lets the isomorphic http-client find server-side
     * context without importing core-context itself.
     */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (recorder, meta objects)
    readValue(key: ContextKey): unknown {
        return RequestContext.getHeader(key);
    }
}
