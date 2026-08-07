import { AnyContextKey, ContextReader } from '@webpieces/core-util';
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
    read(key: AnyContextKey): string | undefined {
        // `key` is a generically-typed AnyContextKey here (the reader is key-agnostic) — mixed in
        // both value type and trust — so it reads through getAny (serialization, not a trust
        // decision) and narrows to this method's string-only contract.
        const value = RequestContext.getAny(key);
        return typeof value === 'string' ? value : undefined;
    }

    /**
     * Read a non-string context value (e.g. the active TestCaseRecorder under
     * RecorderKeys.RECORDER). Lets the isomorphic http-client find server-side
     * context without importing core-context itself.
     */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (recorder, meta objects)
    readValue(key: AnyContextKey): unknown {
        return RequestContext.getAny(key);
    }
}
