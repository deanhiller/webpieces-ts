import { ContextKey } from './ContextKey';

/**
 * ContextTuple - one (ContextKey, value) pair to be stamped into the request's
 * "magic context" (RequestContext on the server) — e.g. USER_ID, ORG_ID. The JWT
 * parse plugin returns these so the framework can set them via RequestContext.putHeader.
 * Data-only structure (a class, per the guidelines).
 */
export class ContextTuple {
    constructor(
        public readonly key: ContextKey,
        // webpieces-disable no-any-unknown -- context values are arbitrary app-defined data
        public readonly value: unknown,
    ) {}
}
