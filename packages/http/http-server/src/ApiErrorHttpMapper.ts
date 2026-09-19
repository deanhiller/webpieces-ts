import {
    ApiErrorBoundary,
    ApiErrorHttpStatus,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    PublishedKind,
} from '@webpieces/core-util';

/**
 * How a server answers an {@link ApiEndUserError}.
 *
 * - `'gui'` (the default): 266. The call succeeded; the GUI (or any webpieces client, including the
 *   next server-to-server hop) decodes the error and shows its message. `edgeHttpStatus` is ignored,
 *   and still travels in the body so a downstream edge can use it.
 * - `'edge'`: a partner/public REST edge whose published contract promises real 4xx statuses. The
 *   response carries `edgeHttpStatus`, or 400 when the thrower set none (still a caller-fixable
 *   end-user outcome). Only for the OUTERMOST server: a webpieces client receiving an end-user body at
 *   anything other than 266 treats it as a mismatched response, so internal hops stay `'gui'`.
 *
 * Chosen per router with `WebpiecesExpressRouter.setEndUserStatus`.
 */
export type EndUserStatus = 'gui' | 'edge';

/**
 * HTTP adapter for the transport-neutral API error taxonomy, and the webpieces DEFAULT
 * {@link ErrorTranslators} half on the server: an error in, the exact HTTP response out.
 *
 * An app that registers its own translator declines by DELEGATING here —
 * `new ApiErrorHttpMapper('gui').toResponse(error)` — so "no translator registered" and "a
 * translator that does not claim this error" produce byte-identical responses.
 */
export class ApiErrorHttpMapper {
    /**
     * @param endUserStatus - `'gui'` (the framework default) or `'edge'`. A router configured with
     *   `setEndUserStatus('edge')` must pass `'edge'` here too when it delegates from its own
     *   translator, or a delegated end-user error would answer 266 instead of its published status.
     */
    constructor(private readonly endUserStatus: EndUserStatus = 'gui') {}

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
     * The payload IS the answer. {@link ApiErrorBoundary.encode} has already applied both shared
     * rules — a caller-local `ApiConnectionError` (and every non-`ApiError`) publishes as
     * `implementation`, and only an `ApiEndUserError`'s own message is disclosed — and the payload
     * carries everything HTTP needs after that: `kind`, `statusCode`, `edgeHttpStatus` and
     * `retryAfterSeconds`. So there is no `instanceof` here and nothing re-derived from the raw
     * error; unknown throws and caller-local failures come out as a 500 implementation failure
     * because that is what the payload says.
     */
    public toResponse(error: Error): HttpResponseDto {
        const payload = this.boundary.encode(error);
        // The boundary never publishes kind 'connection' — that is the whole first rule above — so
        // this is the published subset ApiErrorHttpStatus.codeFor accepts.
        const kind = payload.kind as PublishedKind;
        const status =
            this.endUserStatus === 'edge' && kind === 'end-user'
                ? (payload.edgeHttpStatus ?? 400)
                : ApiErrorHttpStatus.codeFor(kind, payload.statusCode);
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

    public genericMessage(code: number): string {
        return this.genericMessages.get(code) ?? 'Request Failed';
    }
}
