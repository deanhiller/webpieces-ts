import {
    ApiBadRequestError,
    ApiConnectionError,
    ApiDependencyBackoffError,
    ApiEndUserError,
    ApiError,
    ApiErrorCodec,
    ApiForbiddenError,
    ApiImplementationError,
    ApiNotFoundError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
    ApiErrorHttpStatus,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    LogManager,
    toError,
} from '@webpieces/core-util';

const log = LogManager.getLogger('ApiErrorHttpMapper');

/** HTTP adapter for the transport-neutral API error taxonomy. */
export class ApiErrorHttpMapper {
    private readonly genericMessages: Map<number, string> = new Map<number, string>([
        [266, 'End User Error'],
        [400, 'Bad Request'],
        [401, 'Unauthorized'],
        [403, 'Forbidden'],
        [404, 'Not Found'],
        [408, 'Request Timeout'],
        [429, 'Too Many Requests'],
        [500, 'Internal Server Error'],
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
        const error = this.normalize(thrown);
        const status = ApiErrorHttpStatus.code(error);
        this.logOperatorDetail(error);
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

    // webpieces-disable no-any-unknown -- thrown values are unknown until normalized
    private normalize(thrown: unknown): ApiError {
        if (thrown instanceof ApiError && !(thrown instanceof ApiConnectionError)) return thrown;
        const error = toError(thrown);
        return new ApiImplementationError(error.message, error);
    }

    private operatorDetail(error: ApiError): string {
        const cause = error.cause instanceof Error ? ` cause=${error.cause.message}` : '';
        return `[name=${error.name} kind=${error.kind} subType=${error.subType ?? 'none'}] ${error.message}${cause}`;
    }

    private logOperatorDetail(error: ApiError): void {
        const detail = this.operatorDetail(error);
        if (error instanceof ApiEndUserError) log.info(`End User Error: ${detail}`);
        else if (error instanceof ApiBadRequestError) log.info(`Bad Request: ${detail}`);
        else if (error instanceof ApiNotFoundError) log.info(`Not Found: ${detail}`);
        else if (error instanceof ApiUnauthorizedError) log.info(`Unauthorized: ${detail}`);
        else if (error instanceof ApiForbiddenError) log.info(`Forbidden: ${detail}`);
        else if (error instanceof ApiRequestTimeoutError) log.error(`Request Timeout: ${detail}`);
        else log.error(`API failure: ${detail}`);
    }
}
