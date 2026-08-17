import { ProtocolError } from '@webpieces/core-util';

/**
 * `application/json`, plus every `+json` structured suffix (`application/problem+json`,
 * `application/vnd.acme.v2+json`). Parameters (`; charset=utf-8`) are ignored, and matching is
 * case-insensitive because a content-type is case-insensitive on the wire.
 */
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/** How much of a non-JSON body to quote in the error message — enough to identify it, not a dump. */
const SNIPPET_CHARS = 200;

/**
 * ResponseBodyReader — decides whether a response body may be `JSON.parse`d AT ALL, from its
 * `content-type`, before anything tries.
 *
 * WHY THIS EXISTS: the client used to call `response.json()` on every body regardless of what the
 * response said it was. A scale-to-zero backend answers a cold start with the load balancer's own
 * **HTML** error page, so a 502 arrived at the app as `SyntaxError: Unexpected token '<'` — the
 * status thrown away, and infrastructure indistinguishable from a code defect. Apps showed users a
 * "Client Bug" dialog for a server that was merely booting.
 *
 * The rule, and the whole of it: **only parse a body that CLAIMS to be JSON.** Then
 * - a non-JSON error body becomes a synthesized {@link ProtocolError} that `ClientErrorTranslator`
 *   maps by STATUS — 502 → `HttpBadGatewayError`, 503 → `HttpServiceUnavailableError`, 504 →
 *   `HttpGatewayTimeoutError` — so a caller can decide "the server is waking, retry";
 * - a `SyntaxError` from `JSON.parse` goes back to meaning what it should: a response that SAID it
 *   was JSON and was malformed. That is a real bug, and it is exactly the signal the old
 *   parse-everything path destroyed.
 */
export class ResponseBodyReader {
    /** True when the response DECLARES a JSON body, and is therefore safe to `JSON.parse`. */
    isJson(response: Response): boolean {
        const contentType = response.headers.get('content-type');
        if (!contentType) {
            return false;
        }
        return JSON_CONTENT_TYPE.test(contentType.trim());
    }

    /**
     * Read a NON-2xx body as a {@link ProtocolError}, whatever it turns out to be.
     *
     * - Declared JSON → parse it. A malformed one still throws `SyntaxError`, on purpose: the server
     *   promised JSON and broke the promise, which is a genuine defect worth surfacing as one.
     * - Anything else → synthesize a ProtocolError describing what actually arrived, so the caller
     *   gets the STATUS-derived typed error instead of a parse failure.
     *
     * @param response - the fetch Response, already known to be non-ok
     * @param callId   - `ApiName.methodName`, so the message names the call that failed
     */
    async readErrorBody(response: Response, callId: string): Promise<ProtocolError> {
        if (this.isJson(response)) {
            return (await response.json()) as ProtocolError;
        }

        const protocolError = new ProtocolError();
        protocolError.message = this.describeForeignBody(response, callId, await response.text());
        return protocolError;
    }

    /**
     * The message for a body that is not ours. It names the status, the content-type that gave it
     * away, and a short quote of the body — the three facts needed to tell "Google Frontend served
     * its own 502 page" apart from "our server returned an error".
     */
    describeForeignBody(response: Response, callId: string, body: string): string {
        const contentType = response.headers.get('content-type') || '(none)';
        return (
            `${callId}: HTTP ${response.status} with content-type "${contentType}" — this response did ` +
            `not come from the webpieces server (no ProtocolError body). It is almost certainly ` +
            `infrastructure: a load balancer, a proxy, or a cold start on a scale-to-zero backend. ` +
            `body=${JSON.stringify(this.snippet(body))}`
        );
    }

    /** First {@link SNIPPET_CHARS} characters, whitespace collapsed so an HTML page stays one line. */
    private snippet(body: string): string {
        const collapsed = body.replace(/\s+/g, ' ').trim();
        if (collapsed.length <= SNIPPET_CHARS) {
            return collapsed;
        }
        return `${collapsed.slice(0, SNIPPET_CHARS)}…`;
    }
}
