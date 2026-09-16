import {
    ApiDependencyBackoffError,
    ApiErrorBoundary,
    ApiErrorCodec,
    ApiErrorHttpStatus,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    LogManager,
} from '@webpieces/core-util';

const log = LogManager.getLogger('ApiErrorHttpMapper');

/** HTTP adapter for the transport-neutral API error taxonomy. */
export class ApiErrorHttpMapper {
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
     * Unknown throws and caller-local failures become a concrete implementation failure at this
     * owning API boundary. ApiError itself has no fallback status mapping.
     */
    // webpieces-disable no-any-unknown -- thrown values are unknown until normalized at this boundary
    public toResponse(thrown: unknown): HttpResponseDto {
        const error = this.boundary.normalize(thrown);
        const status = ApiErrorHttpStatus.code(error);
        this.boundary.logOperatorDetail(error);
        const headers =
            error instanceof ApiDependencyBackoffError
                ? [new HttpHeader('retry-after', String(error.retryAfterSeconds))]
                : [];
        return new HttpResponseDto(
            new HttpResponseStatus(status, this.genericMessage(status)),
            headers,
            ApiErrorCodec.encode(error),
        );
    }

    public genericMessage(code: number): string {
        return this.genericMessages.get(code) ?? 'Request Failed';
    }
}
