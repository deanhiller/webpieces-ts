import { ProtocolError } from './errors';

/**
 * ErrorWireForm - the wire representation an error translates to: the HTTP status code plus the
 * {@link ProtocolError} body fields. This is exactly what the server writes and the client reads,
 * so the two directions of a translation agree on the same shape.
 *
 * Data-only structure (a class, not an inline object literal, per the webpieces guidelines) so
 * every producer constructs it explicitly.
 */
export class ErrorWireForm {
    constructor(
        public readonly statusCode: number,
        public readonly protocolError: ProtocolError,
    ) {}
}

/**
 * ErrorTranslation - a bidirectional, app-supplied translation between one (or more) exception
 * types and their wire form. An app registers translations ONCE at startup (server AND browser)
 * via {@link ClientRegistry.addErrorTranslation}; they are consulted BEFORE the built-in webpieces
 * mapping (the hard-coded status-code switch on the client, the `instanceof HttpError` ladder on
 * the server).
 *
 * BOTH methods return `undefined` to mean "not mine — fall through to the next registered
 * translation, then to generic webpieces." This single rule is what lets translations be additive
 * (an app ADDS a new error type, e.g. a custom 460) AND override-capable (an app REPLACES how a
 * built-in status like 400 is written/reconstructed): a translation that returns a value wins;
 * one that returns undefined steps aside.
 *
 * Symmetry: `toWire` runs on the SERVER (exception → JSON) and `fromWire` runs on the CLIENT
 * (JSON → exception). Because {@link ErrorTranslation} and {@link ClientRegistry} live in core-util
 * (browser-safe, zero node deps), the identical translation object serves the node server and the
 * Angular/browser client — the same halves the app supplies together.
 *
 * This is a business-logic contract (methods, not data), so it is an interface per the webpieces
 * guidelines.
 */
export interface ErrorTranslation {
    /**
     * exception → JSON. Return the wire form for `error`, or `undefined` if this translation does
     * not handle `error` (→ fall through to the next translation, then to generic webpieces).
     */
    toWire(error: Error): ErrorWireForm | undefined;

    /**
     * JSON → exception. Return the reconstructed, typed error for `(statusCode, protocolError)`, or
     * `undefined` to fall through to the next translation, then to the generic webpieces switch.
     */
    fromWire(statusCode: number, protocolError: ProtocolError): Error | undefined;
}
