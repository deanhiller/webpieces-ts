import {
    ApiDependencyBackoffError,
    ApiEndUserError,
    ApiErrorBoundary,
    ApiErrorHttpStatus,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    LogManager,
} from '@webpieces/core-util';

const log = LogManager.getLogger('ApiErrorHttpMapper');

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

/** HTTP adapter for the transport-neutral API error taxonomy. */
export class ApiErrorHttpMapper {
    constructor(private readonly endUserStatus: EndUserStatus) {}

    private readonly boundary = new ApiErrorBoundary(log);
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
     * Unknown throws and caller-local failures answer as a 500 implementation failure at this owning
     * API boundary. The thrown error itself is never replaced: it is what gets logged and classified.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until classified at this boundary
    public toResponse(thrown: unknown): HttpResponseDto {
        const status = this.statusFor(thrown);
        this.boundary.logOperatorDetail(thrown);
        const headers =
            thrown instanceof ApiDependencyBackoffError
                ? [new HttpHeader('retry-after', String(thrown.retryAfterSeconds))]
                : [];
        return new HttpResponseDto(
            new HttpResponseStatus(status, this.genericMessage(status)),
            headers,
            this.boundary.encode(thrown),
        );
    }

    /**
     * The protocol status; only an end-user error in `'edge'` mode departs from the shared mapping.
     * Anything the boundary does not classify as an API outcome is this server's own bug: 500.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until classified at this boundary
    private statusFor(thrown: unknown): number {
        const error = this.boundary.apiOutcome(thrown);
        if (!error) return 500;
        if (this.endUserStatus === 'edge' && error instanceof ApiEndUserError) {
            return error.edgeHttpStatus ?? 400;
        }
        return ApiErrorHttpStatus.code(error);
    }

    public genericMessage(code: number): string {
        return this.genericMessages.get(code) ?? 'Request Failed';
    }
}
