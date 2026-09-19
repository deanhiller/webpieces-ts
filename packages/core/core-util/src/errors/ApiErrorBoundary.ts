import { ApiErrorCodec, ApiErrorPayload } from './ApiErrorCodec';
import { ApiConnectionError, ApiError } from './ApiError';

/**
 * The ONE rule every outbound protocol boundary (HTTP server, MCP, IPC, streams) applies to a
 * thrown error before rendering it: an error in, the exact wire payload out.
 *
 * ONE method, because there is exactly one question — "what does THIS service publish for this
 * error?" — and it used to be asked three times per failure (`statusFor`, `logOperatorDetail`,
 * `encode`), each re-classifying the same throw. Everything an adapter needs afterwards is ON the
 * returned {@link ApiErrorPayload}: `kind`, `message`, `statusCode`, `edgeHttpStatus` and
 * `retryAfterSeconds`. No adapter re-derives anything from the raw error.
 *
 * Two rules, and they are the whole class:
 *
 * 1. CLASSIFICATION. A connection failure is OUR outbound call failing, so from our caller's seat
 *    THIS service is the thing that is broken: an {@link ApiConnectionError} publishes as
 *    `implementation`, never as `connection`. That rule is deliberately NOT in {@link ApiErrorCodec},
 *    which encodes a value faithfully; it belongs to the boundary that owns the failure.
 * 2. DISCLOSURE. Only an `ApiEndUserError`'s own message is ever published; everything else gets
 *    allowlisted generic text by kind (see {@link ApiErrorCodec}).
 *
 * Nothing here SUBSTITUTES an object for the value that was thrown: the thrown error survives to
 * every consumer, so an app can still `instanceof` its own error class. Classification is a VALUE
 * computed from the thrown error, never a wrapper around it.
 *
 * OPERATOR LOGGING IS NOT HERE, on purpose. `LogApiCall` (via `LogApiFilter` on the server and
 * `ProxyClient` on a client) already writes one `[API-{side}-resp-FAIL]` / `-OTHER` line per failed
 * call, WITH the request, the identity and the timing. A second bare line at the protocol edge was
 * the exact defect `ErrorLogFilter` was deleted for, one layer down. An edge with no filter above it
 * (MCP bearer verification, Origin, a malformed body, `tools/list`) wraps its own work in
 * `LogApiCall` instead.
 */
export class ApiErrorBoundary {
    /**
     * The wire payload THIS service publishes for `error`.
     *
     * A non-`ApiError` — an app's own `MyLibError extends Error`, a library's error, anything at all
     * — and a caller-local {@link ApiConnectionError} both publish as a bare `implementation`
     * failure, so neither the error's own text nor a downstream host name can reach the wire.
     */
    encode(error: Error): ApiErrorPayload {
        if (error instanceof ApiError && !(error instanceof ApiConnectionError)) {
            return ApiErrorCodec.encode(error);
        }
        return new ApiErrorPayload('implementation', 'Internal Error');
    }
}
