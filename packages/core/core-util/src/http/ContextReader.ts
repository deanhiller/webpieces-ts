import { ContextKey } from '../ContextKey';

/**
 * ContextReader - reads context-key values from the ambient magic context.
 *
 * There are exactly TWO implementations, one per environment:
 * - Node/server: `RequestContextReader` (in @webpieces/core-context) — reads the
 *   AsyncLocalStorage-backed RequestContext.
 * - Browser: `MutableContextStore` (in @webpieces/http-client) — a mutable in-memory
 *   store the app sets as values become known (login token, tenant, ...).
 *
 * Defined in core-util (browser + Node safe, DI-independent) so both sides can use it
 * without a circular dependency.
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
