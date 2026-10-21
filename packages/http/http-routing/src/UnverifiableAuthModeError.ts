/**
 * A SERVED endpoint declares an auth mode this server cannot verify, because the binding that mode
 * needs is absent (#1362). Thrown at STARTUP, from route registration (`RouteBuilderImpl.addRoute` ->
 * `AuthFilter.assertRouteVerifiable`), so the process refuses to boot instead of answering the first
 * vendor / partner / user request with a 401 that reads as an outage on their side.
 *
 * Its own type, carrying the facts as fields, so a boot log or a spec names the endpoint and the mode
 * without parsing the message. The message itself carries the exact binding line to add.
 */
export class UnverifiableAuthModeError extends Error {
    constructor(
        message: string,
        /** `Contract.method (VERB /path)` — which served endpoint cannot be verified. */
        public readonly endpoint: string,
        /** The declared mode nobody can verify, e.g. `vendorAuth('bugfixer-sentry')`, `jwt()`. */
        public readonly mode: string,
    ) {
        super(message);
        this.name = 'UnverifiableAuthModeError';
    }
}
