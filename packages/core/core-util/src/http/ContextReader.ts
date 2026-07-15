import { ContextKey } from '../ContextKey';

/**
 * Reads one context key's string value. The ONE seam between the two environments:
 * the server passes `RequestContext.getHeader`, a browser passes its store's read.
 *
 * A lambda, not an object — nothing here needs an implementation to hold.
 */
export type ContextRead = (key: ContextKey) => string | undefined;

/**
 * Reads one context key's value WITHOUT narrowing to string — a key may hold an object
 * (e.g. {@link ApiCallInfo} under API_CALL_INFO). Used only by
 * {@link HeaderRegistry.buildStructuredLogFields} for the node logging backends, which can emit
 * object values as nested `jsonPayload.<name>`. Server passes `RequestContext.getHeader`.
 */
// webpieces-disable no-any-unknown -- structured log values are heterogeneous (strings + api struct)
export type StructuredContextRead = (key: ContextKey) => unknown;

/**
 * ContextReader - reads context-key values from an app-held store.
 *
 * BROWSER-ONLY. Browsers have no AsyncLocalStorage and therefore no ambient request scope, so the
 * app holds a `MutableContextStore` (in @webpieces/http-client-browser) and sets values as they
 * become known (login token, tenant, ...).
 *
 * The server has no use for this: there is exactly one right answer there, so `RequestContextHeaders`
 * (in @webpieces/core-context) reads `RequestContext` directly rather than through a reader object.
 *
 * Note this is only about where VALUES live. The key SCHEMA — which keys exist, which transfer, which
 * are secured — is the global {@link HeaderRegistry}, and that is browser-safe and shared by both.
 *
 * This is a business-logic interface (per CLAUDE.md: behavior = interface).
 */
export interface ContextReader {
    /**
     * Read the string value of a context key. Returns undefined if not present.
     */
    read(key: ContextKey): string | undefined;

    /**
     * OPTIONAL: read a non-string context value (e.g. the active TestCaseRecorder
     * under RecorderKeys.RECORDER). Server-side readers implement this over the
     * RequestContext; browser readers may omit it (no server-side recording in
     * browsers — same as Java).
     */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (recorder, meta objects)
    readValue?(key: ContextKey): unknown;
}
