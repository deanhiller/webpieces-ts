import { ApiErrorBoundary } from '../errors/ApiErrorBoundary';
import { ApiErrorCodec } from '../errors/ApiErrorCodec';
import { ApiCodedError, ApiError } from '../errors/ApiError';
import { ReceivedApiErrorRule } from '../errors/ReceivedApiErrorRule';
import { ApiErrorHttpStatus, PublishedKind } from './ApiErrorHttpStatus';
import { ErrorTranslator } from './ErrorTranslator';
import { HttpHeader, HttpResponseDto, HttpResponseStatus } from './HttpResponseDto';

/**
 * THE webpieces default {@link ErrorTranslator} — ONE class, BOTH halves, used by the node server, by
 * every node client and by the browser bundle alike.
 *
 * It is what {@link ClientRegistry.getErrorTranslator} holds until an app installs its own, and it is
 * what an app's own translator calls to DECLINE an error:
 *
 * ```ts
 * private readonly fallback = new WebpiecesDefaultErrorTranslator();
 * ```
 *
 * so "no translator registered" and "a translator that does not claim this error" produce
 * byte-identical output. It lives in core-util, beside {@link ClientRegistry}, because core-util is
 * the package every API contract already depends on and the only one both a server and a browser
 * bundle can reach. Both halves needed nothing else: the outbound half wants
 * {@link ApiErrorBoundary} + {@link ApiErrorHttpStatus}, the inbound half wants
 * {@link ApiErrorCodec} + {@link ReceivedApiErrorRule}, and all four were already here.
 *
 * Stateless, so {@link WEBPIECES_DEFAULT_ERROR_TRANSLATOR} is a shared instance — but constructing
 * your own costs nothing and reads better at a delegation site.
 */
export class WebpiecesDefaultErrorTranslator implements ErrorTranslator {
    private readonly boundary = new ApiErrorBoundary();

    private readonly genericMessages: Map<number, string> = new Map<number, string>([
        [266, 'End User Error'],
        [400, 'Bad Request'],
        [401, 'Unauthorized'],
        [403, 'Forbidden'],
        [404, 'Not Found'],
        [408, 'Request Timeout'],
        [409, 'Conflict'],
        [412, 'Precondition Failed'],
        [415, 'Unsupported Media Type'],
        [422, 'Unprocessable Content'],
        [429, 'Too Many Requests'],
        [500, 'Internal Server Error'],
        [501, 'Not Implemented'],
        [502, 'Bad Gateway'],
        [503, 'Service Unavailable'],
        [504, 'Gateway Timeout'],
    ]);

    /**
     * SERVER: an exception in, the exact HTTP response out.
     *
     * The payload IS the answer. {@link ApiErrorBoundary.encode} has already applied both shared
     * rules — a caller-local `ApiConnectionError` (and every non-`ApiError`) publishes as
     * `implementation`, and only an `ApiEndUserError`'s own message is disclosed — and the payload
     * carries everything HTTP needs after that: `kind`, `statusCode`, `edgeHttpStatus` and
     * `retryAfterSeconds`. So there is no `instanceof` here and nothing re-derived from the raw
     * error; unknown throws and caller-local failures come out as a 500 implementation failure
     * because that is what the payload says.
     *
     * An `ApiEndUserError` publishes 266 here, ALWAYS. Whether a particular REQUEST republishes that
     * as a real 4xx is a property of the CALLER, not of the error, so it is decided once per request
     * from `WebpiecesCoreHeaders.SURFACE` by the server boundary (`ExpressWrapper.handleError`) —
     * see {@link SurfaceEndUserStatus}. That is why this class takes no constructor argument any
     * more: the old `new ApiErrorHttpMapper('gui' | 'edge')` made every delegating app translator
     * responsible for repeating its router's mode, and repeating it wrongly was silent.
     */
    toWire(error: Error): HttpResponseDto {
        const payload = this.boundary.encode(error);
        // The boundary never publishes kind 'connection' — that is the whole first rule above — so
        // this is the published subset ApiErrorHttpStatus.codeFor accepts.
        const kind = payload.kind as PublishedKind;
        const status = ApiErrorHttpStatus.codeFor(kind, payload.statusCode);
        const headers =
            payload.retryAfterSeconds !== undefined
                ? [new HttpHeader('retry-after', String(payload.retryAfterSeconds))]
                : [];
        return new HttpResponseDto(
            new HttpResponseStatus(status, this.genericMessage(status)),
            headers,
            payload,
        );
    }

    /**
     * CLIENT: the response in, a THROW out — or a silent return for an ordinary success.
     *
     * Called for EVERY response, 2xx included (see {@link ErrorTranslator.fromWire}). A 2xx that is
     * not 266 is exactly the case where webpieces has nothing to say, so it returns and the caller
     * gets its DTO. Everything else throws, which is what lets `ProxyClient` call this and then simply
     * stop — a failure response can never fall through to a typed caller.
     *
     * The rule applied is {@link ReceivedApiErrorRule}, shared verbatim with IPC: 4xx is MY bug, 5xx
     * is THEIRS, an `ApiDependencyError` is already attributed and passes through, 266 is the end
     * user's own answer.
     */
    fromWire(response: HttpResponseDto): void {
        const code = response.status.code;
        if (code >= 200 && code < 300 && code !== 266) {
            return;
        }
        const decoded = this.decodeBody(response);
        const message = decoded?.message ?? this.fallbackMessage(response.body, response.status.reason);
        throw ReceivedApiErrorRule.adapt(code, message, decoded);
    }

    /** The reason phrase webpieces writes beside a status it chose itself. */
    genericMessage(code: number): string {
        return this.genericMessages.get(code) ?? 'Request Failed';
    }

    /**
     * A webpieces peer sends an {@link ApiErrorPayload}; a foreign responder sends anything at all.
     * The status is only believed when it AGREES with the kind the body claims — a body saying
     * `not-found` beside a 500 is a mismatched response, not a 404, and falls back to the status.
     */
    private decodeBody(response: HttpResponseDto): ApiError | undefined {
        if (!ApiErrorCodec.isPayload(response.body)) {
            return undefined;
        }
        const decoded = ApiErrorCodec.decode(response.body);
        if (!ApiErrorHttpStatus.hasCode(decoded)) {
            return undefined;
        }
        // `statusCode` is the 'coded' kind's own status, the one thing the shared table cannot know.
        const statusCode = decoded instanceof ApiCodedError ? decoded.statusCode : undefined;
        const declared = ApiErrorHttpStatus.codeFor(decoded.kind, statusCode);
        return declared === response.status.code ? decoded : undefined;
    }

    // webpieces-disable no-any-unknown -- HTTP response bodies are app-owned until this boundary safely inspects them
    private fallbackMessage(body: unknown, reason: string): string {
        if (typeof body === 'object' && body !== null) {
            const message = Object.getOwnPropertyDescriptor(body, 'message')?.value;
            if (typeof message === 'string' && message.length > 0) return message.slice(0, 4096);
        }
        return reason || 'Request Failed';
    }
}

/** Process-wide built-in instance — stateless, so one shared instance is enough. */
export const WEBPIECES_DEFAULT_ERROR_TRANSLATOR = new WebpiecesDefaultErrorTranslator();
