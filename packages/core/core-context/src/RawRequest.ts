/**
 * RawRequest - the parts of an inbound request a SIGNATURE is computed over, retained verbatim.
 *
 * It exists because every signed webhook (Sentry, GitHub, Stripe, Slack, Twilio) verifies a
 * derivation over what the SENDER transmitted, and the ordinary request path destroys exactly that:
 * the body is parsed into a DTO and the bytes are dropped. Re-stringifying the DTO is NOT a
 * substitute — `JSON.stringify` of a parsed object differs from the wire bytes in non-ASCII escaping,
 * number formatting (`1e3` vs `1000`) and duplicate-key resolution, so a check built on it passes
 * every test and then 401s the first payload containing an emoji. Worse than no check.
 *
 * It is REQUEST-shaped rather than body-shaped on purpose. Twilio — the vendor this framework already
 * built `formPost` for — signs the absolute URL plus the sorted POST params, not the raw body at all,
 * so a seam that handed out only `rawBody` could not verify it.
 *
 * Retained ONLY for an `@Endpoint(..., { rawBody: true })` route, so the cost lands on webhook routes
 * instead of on every request in the process.
 *
 * Per CLAUDE.md: data-only, therefore a class.
 */
export class RawRequest {
    constructor(
        /**
         * The ABSOLUTE url as the SENDER addressed it — scheme + host + path + query.
         *
         * Behind a TLS-terminating proxy (Cloud Run, any load balancer) express's own view is wrong
         * in both halves: `req.protocol` reads `http` and the host is the internal one, while Twilio
         * signs the public `https://...` url the customer configured. The express adapter therefore
         * builds this from `x-forwarded-proto` / `x-forwarded-host` when present, falling back to
         * `req.protocol` / the Host header. That is the ONE reconstruction rule; an app that fronts
         * itself with something rewriting neither header gets a signature mismatch, so the rule is
         * stated here rather than left for each app to guess at.
         */
        public readonly absoluteUrl: string,
        /**
         * The exact transmitted bytes. A Buffer, not a string: some schemes sign bytes, and a string
         * would bake in a UTF-8 decode that corrupts a non-UTF-8 body before the app ever sees it.
         */
        public readonly rawBody: Buffer,
        /** The peer address, when the transport knows it. Some vendors also publish IP ranges. */
        public readonly remoteAddr?: string,
        /**
         * Set when the body could NOT be parsed, instead of failing the request then and there.
         *
         * The failure is HELD so that AUTHENTICATION answers first. A malformed body from an
         * unauthenticated caller must be a 401, not a 400 — a 400 says "your JSON was bad", which
         * says "I got past auth", which is a free oracle on an endpoint whose url is public by
         * construction. `AuthFilter` rethrows it as a 400 once, and only once, the caller is proven.
         */
        public readonly bodyParseError?: Error,
    ) {}
}
