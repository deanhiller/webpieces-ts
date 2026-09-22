import { AnyUntrustedContextKey, ContextKey } from '../ContextKey';
import { ContextReader } from './ContextReader';

/**
 * ContextWriter - writes context-key values INTO an app-held store.
 *
 * BROWSER-ONLY, and the exact mirror of {@link ContextReader}. It exists because the context is no
 * longer a one-way street: a webpieces client reads a callee's RESPONSE headers back into the
 * caller's context (see `ContextMgr.acceptResponseHeaders`), and in a browser "the caller's context"
 * IS the app-held store. A reader-only seam could propagate a value DOWN and never back UP.
 *
 * UNTRUSTED keys only, by type — the same rule {@link MutableContextStore.set} already enforced, now
 * stated at the seam rather than at one implementation of it. A browser cannot PROVE anything, so a
 * store that accepted a trusted key would be a forgery side door.
 *
 * `value` is `unknown` rather than `string` because a `collect` key holds a LIST (see
 * {@link ContextKey.mergeResponseValue}); {@link ContextReader.read} keeps its string return and
 * simply does not see those, which is correct — a list has no single outbound header value.
 *
 * This is a business-logic interface (per CLAUDE.md: behavior = interface).
 */
export interface ContextWriter {
    // webpieces-disable no-any-unknown -- context values are heterogeneous: a scalar key holds a string, a `collect` key holds a list
    set(key: AnyUntrustedContextKey, value: unknown): void;
}

/**
 * The app-held browser context store, read AND write — what {@link ContextMgr} needs, and what
 * {@link MutableContextStore} is. Named as one type so a browser app implements one thing rather
 * than correlating two.
 */
export type ContextStore = ContextReader & ContextWriter;
