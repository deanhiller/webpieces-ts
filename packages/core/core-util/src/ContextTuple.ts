import { AnyTrustedContextKey } from './ContextKey';

/**
 * ContextTuple - one (ContextKey, value) pair to be stamped into the request's
 * "magic context" (RequestContext on the server) — e.g. USER_ID, ORG_ID. The JWT
 * parse plugin returns these so the framework can set them via `RequestContext.putTrusted`.
 * Data-only structure (a class, per the guidelines).
 *
 * The key is deliberately an {@link AnyTrustedContextKey}, not any old key: everything in here was
 * derived from a VERIFIED credential, so stamping an untrusted key from a JWT parse is a category
 * error and does not compile. This is also what lets `AuthFilter` treat "the authenticator claimed
 * this key" as the definition of trusted — see its reconciliation of pending wire values.
 */
export class ContextTuple {
    constructor(
        public readonly key: AnyTrustedContextKey,
        // webpieces-disable no-any-unknown -- context values are arbitrary app-defined data
        public readonly value: unknown,
    ) {}
}
