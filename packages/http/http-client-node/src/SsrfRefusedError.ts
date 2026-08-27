/**
 * We refused to SEND a request, because the destination failed this client's SSRF policy.
 *
 * Its own type rather than a bare Error so an app can tell "the partner's endpoint rejected us"
 * (an HttpError carrying their status) from "we never contacted the partner at all" — those are
 * different incidents with different owners, and only the second one means the URL in our database
 * is hostile or wrong. A delivery worker typically dead-letters this instead of retrying: no number
 * of retries makes 127.0.0.1 an acceptable destination.
 *
 * The message names the URL, the address it resolved to when that is what condemned it, and the
 * ONE named opt-out that would allow it — so the reader does not have to go looking for whether an
 * escape exists.
 */
export class SsrfRefusedError extends Error {
    constructor(
        message: string,
        /** The URL that was refused, verbatim, so a log line identifies the offending row. */
        public readonly refusedUrl: string,
    ) {
        super(message);
        this.name = 'SsrfRefusedError';
    }
}
