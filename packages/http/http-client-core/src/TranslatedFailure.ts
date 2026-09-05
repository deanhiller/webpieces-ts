/**
 * What {@link ClientErrorTranslator.translateError} decided about ONE non-2xx downstream response —
 * the typed error, plus WHO decided it.
 *
 * DATA ONLY (no behavior), so it is a class with an explicit constructor rather than an interface,
 * exactly like {@link RequestOutcome}.
 *
 * WHY IT CARRIES `appRegistered` AT ALL: the translated error alone is not enough for an environment
 * hook to act on. `HttpNotFoundError` produced by the BUILT-IN 404 branch and `HttpNotFoundError`
 * produced by an app's own `ErrorTranslation` are indistinguishable as values, yet they mean opposite
 * things — the first is the framework's generic default, the second is the app saying out loud, at
 * startup and greppably, "relay this status as my own". `ProxyClient.adaptDownstreamFailure` must
 * honour the second and is free to replace the first, so the provenance has to travel WITH the error
 * rather than be re-derived by consulting `ClientRegistry` a second time.
 *
 * `statusCode` is the status the DOWNSTREAM answered — carried explicitly rather than read back off
 * `error.code`, because an app-registered translation may legitimately return an error whose `code`
 * is nothing like the status that produced it, and need not be an `HttpError` at all.
 */
export class TranslatedFailure {
    constructor(
        /** The typed error the translator picked for this response. Always a real `Error`. */
        public readonly error: Error,
        /**
         * True when an app-registered `ClientRegistry` translation claimed this status — i.e. the app
         * chose this error type deliberately, at startup, in one greppable place. False when the
         * framework's built-in status mapping produced it.
         *
         * This IS the caller's explicit opt-out from any environment-specific rewrite: see
         * `NodeProxyClient.adaptDownstreamFailure`, where an app-registered 4xx wins over the
         * server-to-server 4xx-to-500 wrap.
         */
        public readonly appRegistered: boolean,
        /** The HTTP status the downstream dependency actually answered with. */
        public readonly statusCode: number,
    ) {}
}
