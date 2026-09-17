import {
    ApiBadRequestError,
    ApiCodedError,
    ApiConflictError,
    ApiConnectionError,
    ApiDependencyBackoffError,
    ApiDependencyError,
    ApiDependencyTimeoutError,
    ApiEndpointNotFoundError,
    ApiEndUserError,
    ApiError,
    ApiErrorKind,
    ApiForbiddenError,
    ApiImplementationError,
    ApiNotFoundError,
    ApiNotImplementedError,
    ApiPreconditionFailedError,
    ApiRateLimitedError,
    ApiRequestTimeoutError,
    ApiUnauthorizedError,
    ApiUnavailableError,
    ApiUnprocessableError,
    ApiUnsupportedMediaTypeError,
    EdgeHttpStatus,
} from './ApiError';

/** Allowlisted transport-neutral envelope. It never contains stacks or arbitrary properties. */
export class ApiErrorPayload {
    public cause?: ApiErrorPayload;
    public subType?: string;
    public field?: string;
    public callerMessage?: string;
    public errorCode?: string;
    public retryAfterSeconds?: number;
    public statusCode?: number;
    /** {@link ApiEndUserError.edgeHttpStatus}; absent when the thrower (or an older peer) set none. */
    public edgeHttpStatus?: number;

    constructor(
        public kind: string = 'implementation',
        public message: string = 'Internal Error',
    ) {}
}

/** Bounded safe codec shared by HTTP, IPC, and other remote adapters. */
export class ApiErrorCodec {
    // webpieces-disable no-function-outside-class -- stateless public transport codec; webpieces-disable no-any-unknown -- thrown values are untrusted until narrowed
    static encode(error: unknown): ApiErrorPayload {
        return this.encodeDepth(error, 0);
    }

    // webpieces-disable no-function-outside-class -- recursive bounded transport codec; webpieces-disable no-any-unknown -- thrown causes require narrowing
    private static encodeDepth(error: unknown, depth: number): ApiErrorPayload {
        const kind = error instanceof ApiError ? error.kind : 'implementation';
        const payload = new ApiErrorPayload(kind, this.publicMessage(error, kind));
        if (error instanceof ApiError) payload.subType = this.text(error.subType);
        if (error instanceof ApiEndUserError) {
            payload.errorCode = this.text(error.errorCode);
            payload.edgeHttpStatus = error.edgeHttpStatus;
        }
        if (error instanceof ApiCodedError) {
            payload.statusCode = error.statusCode;
            payload.errorCode = this.text(error.errorCode);
        }
        if (error instanceof ApiBadRequestError) {
            payload.field = this.text(error.field);
            payload.callerMessage = this.text(error.callerMessage);
        }
        if (error instanceof ApiDependencyBackoffError) {
            payload.retryAfterSeconds = this.wait(error.retryAfterSeconds);
        }
        if (error instanceof Error && depth < 3) {
            const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
            if (cause instanceof Error) payload.cause = this.encodeDepth(cause, depth + 1);
        }
        return payload;
    }

    /** Decode a value received from another process. Implementation failures are marked remote. */
    // webpieces-disable no-function-outside-class -- stateless public transport codec; webpieces-disable no-any-unknown -- wire values require validation
    static decode(value: unknown): ApiError {
        return this.decodeDepth(value, 0);
    }

    /** Whether a body carries a recognized Webpieces semantic discriminator. */
    // webpieces-disable no-function-outside-class -- stateless wire discriminator check; webpieces-disable no-any-unknown -- wire values require validation
    static isPayload(value: unknown): boolean {
        if (typeof value !== 'object' || value === null) return false;
        const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
        return typeof kind === 'string' && this.kinds.has(kind as ApiErrorKind);
    }

    // webpieces-disable no-function-outside-class -- recursive bounded transport codec; webpieces-disable no-any-unknown -- remote causes require validation
    private static decodeDepth(value: unknown, depth: number): ApiError {
        const error = this.decodeOne(value);
        if (typeof value === 'object' && value !== null && depth < 3) {
            const cause = Object.getOwnPropertyDescriptor(value, 'cause')?.value;
            if (typeof cause === 'object' && cause !== null) {
                // webpieces-disable no-anonymous-object-literals -- standard descriptor preserves Error.cause semantics
                Object.defineProperty(error, 'cause', {
                    value: this.decodeDepth(cause, depth + 1),
                    configurable: true,
                    writable: true,
                });
            }
        }
        return error;
    }

    // webpieces-disable no-function-outside-class -- allowlisted wire codec; webpieces-disable no-any-unknown -- wire fields require validation
    private static decodeOne(value: unknown): ApiError {
        if (typeof value !== 'object' || value === null) return this.remoteImplementationError();
        // webpieces-disable no-any-unknown -- own wire fields remain untrusted until narrowed
        const field = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
        const kind = field('kind');
        const message = this.text(field('message')) ?? this.message(kind);
        switch (kind) {
            case 'end-user':
                return new ApiEndUserError(
                    message,
                    this.text(field('errorCode')),
                    this.edgeStatus(field('edgeHttpStatus')),
                );
            case 'bad-request':
                return new ApiBadRequestError(
                    message,
                    this.text(field('field')),
                    this.text(field('callerMessage')),
                );
            case 'unauthorized':
                return new ApiUnauthorizedError(message, this.text(field('subType')));
            case 'forbidden':
                return new ApiForbiddenError(message);
            case 'not-found':
                return new ApiNotFoundError(message);
            case 'endpoint-not-found':
                return new ApiEndpointNotFoundError(message);
            case 'request-timeout':
                return new ApiRequestTimeoutError(message);
            case 'rate-limited':
                return new ApiRateLimitedError(message);
            case 'conflict':
                return new ApiConflictError(message);
            case 'unprocessable':
                return new ApiUnprocessableError(message);
            case 'precondition-failed':
                return new ApiPreconditionFailedError(message);
            case 'unsupported-media-type':
                return new ApiUnsupportedMediaTypeError(message);
            case 'not-implemented':
                return new ApiNotImplementedError(message);
            case 'coded':
                return this.coded(message, field('statusCode'), field('errorCode'));
            case 'dependency':
                return new ApiDependencyError(message);
            case 'unavailable':
                return new ApiUnavailableError(message);
            case 'dependency-timeout':
                return new ApiDependencyTimeoutError(message);
            case 'dependency-backoff':
                return new ApiDependencyBackoffError(
                    message,
                    this.wait(field('retryAfterSeconds')),
                );
            case 'connection':
                return new ApiConnectionError(message);
            case 'implementation':
                return new ApiImplementationError(message, undefined, true);
            default:
                return this.remoteImplementationError();
        }
    }

    // webpieces-disable no-function-outside-class -- coded wire decode; webpieces-disable no-any-unknown -- wire fields require validation
    private static coded(message: string, statusCode: unknown, errorCode: unknown): ApiError {
        if (!ApiCodedError.isStatusCode(statusCode)) return this.remoteImplementationError();
        return new ApiCodedError(message, statusCode, this.text(errorCode));
    }

    // webpieces-disable no-function-outside-class -- concrete normalization for malformed remote errors
    private static remoteImplementationError(): ApiImplementationError {
        return new ApiImplementationError('Internal Error', undefined, true);
    }

    // webpieces-disable no-function-outside-class -- caller-safe message selection; webpieces-disable no-any-unknown -- thrown values require narrowing
    private static publicMessage(error: unknown, kind: ApiErrorKind): string {
        if (error instanceof ApiEndUserError) return error.message.slice(0, 4096);
        return this.message(kind);
    }

    // webpieces-disable no-function-outside-class -- wire string bound; webpieces-disable no-any-unknown -- wire values require validation
    private static text(value: unknown): string | undefined {
        return typeof value === 'string' ? value.slice(0, 4096) : undefined;
    }

    /** Tolerant: a peer that sends nothing, or a status outside {@link EdgeHttpStatus}, decodes as undefined. */
    // webpieces-disable no-function-outside-class -- wire status bound; webpieces-disable no-any-unknown -- wire values require validation
    private static edgeStatus(value: unknown): EdgeHttpStatus | undefined {
        return ApiEndUserError.isEdgeHttpStatus(value) ? value : undefined;
    }

    // webpieces-disable no-function-outside-class -- wire number bound; webpieces-disable no-any-unknown -- wire values require validation
    private static wait(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? Math.min(value, 86400)
            : undefined;
    }

    // webpieces-disable no-function-outside-class -- allowlisted generic messages; webpieces-disable no-any-unknown -- discriminator is validated by switch
    private static message(kind: unknown): string {
        switch (kind) {
            case 'end-user':
                return 'End User Error';
            case 'bad-request':
                return 'Bad Request';
            case 'unauthorized':
                return 'Unauthorized';
            case 'forbidden':
                return 'Forbidden';
            case 'not-found':
                return 'Not Found';
            case 'endpoint-not-found':
                return 'Endpoint Not Found';
            case 'request-timeout':
                return 'Request Timeout';
            case 'rate-limited':
                return 'Rate Limited';
            case 'conflict':
                return 'Conflict';
            case 'unprocessable':
                return 'Unprocessable Content';
            case 'precondition-failed':
                return 'Precondition Failed';
            case 'unsupported-media-type':
                return 'Unsupported Media Type';
            case 'not-implemented':
                return 'Not Implemented';
            case 'coded':
                return 'Request Failed';
            case 'dependency':
                return 'Dependency Error';
            case 'unavailable':
                return 'Service Unavailable';
            case 'dependency-timeout':
                return 'Dependency Timeout';
            case 'dependency-backoff':
                return 'Dependency Unavailable';
            case 'connection':
                return 'Connection Error';
            default:
                return 'Internal Error';
        }
    }

    private static readonly kinds: ReadonlySet<ApiErrorKind> = new Set<ApiErrorKind>([
        'end-user',
        'bad-request',
        'unauthorized',
        'forbidden',
        'not-found',
        'endpoint-not-found',
        'request-timeout',
        'rate-limited',
        'conflict',
        'unprocessable',
        'precondition-failed',
        'unsupported-media-type',
        'not-implemented',
        'coded',
        'implementation',
        'dependency',
        'unavailable',
        'dependency-timeout',
        'dependency-backoff',
        'connection',
    ]);
}
