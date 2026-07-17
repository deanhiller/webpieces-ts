/**
 * How one RPC call SETTLED — the payload of {@link ProxyClient.onRequestEnd}.
 *
 * DATA ONLY (no behavior), so it is a class with an explicit constructor rather than an interface:
 * each of the three settle paths in `ProxyClient.executeFetch` constructs it by name, and a reader
 * can see at the call site which path produced which shape.
 *
 * The three shapes, one per path:
 * - 2xx            `new RequestOutcome(true, status, headers)`          — no error
 * - HTTP error     `new RequestOutcome(false, status, headers, error)`  — the translated HttpError
 * - network reject `new RequestOutcome(false, 0, undefined, error)`     — no Response ever existed
 *
 * A fourth path exists but is not a fourth SHAPE: a body that fails to parse (an infra 502 serving
 * HTML) settles as an HTTP error carrying the parse failure.
 */
export class RequestOutcome {
    constructor(
        /** `response.ok` — true only on a 2xx. */
        public readonly ok: boolean,
        /** The HTTP status; 0 when `fetch` itself rejected (network / offline), where there is no status. */
        public readonly status: number,
        /**
         * The Response headers, present whenever an HTTP Response existed (ok OR error) and absent
         * only on a network reject. Read BEFORE the body is consumed, which is what lets an app pull
         * a server-version stamp off an error response.
         */
        public readonly headers?: Headers,
        /**
         * Set on every non-success path: the `HttpError` subclass `ClientErrorTranslator` picked for
         * a non-2xx, or the network/parse failure normalized through `toError`. Always a real
         * `Error` — never `unknown`, because nothing here is untyped: `translateError` RETURNS
         * `Error`, and every rejection reaching this class has been through `toError`.
         */
        public readonly error?: Error,
    ) {}
}
