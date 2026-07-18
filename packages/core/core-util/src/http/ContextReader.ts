import { ContextKey } from '../ContextKey';

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
