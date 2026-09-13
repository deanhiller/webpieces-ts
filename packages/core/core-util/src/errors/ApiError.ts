export type ApiErrorKind =
    | 'end-user'
    | 'bad-request'
    | 'unauthorized'
    | 'forbidden'
    | 'not-found'
    | 'endpoint-not-found'
    | 'request-timeout'
    | 'rate-limited'
    | 'implementation'
    | 'dependency'
    | 'unavailable'
    | 'dependency-timeout'
    | 'dependency-backoff'
    | 'connection';

/** Category for portable API failures. Concrete subclasses alone define protocol mappings. */
export abstract class ApiError extends Error {
    abstract readonly kind: ApiErrorKind;
    public subType?: string;

    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = new.target.name;
    }
}

export class ApiNotFoundError extends ApiError {
    override readonly kind: ApiErrorKind = 'not-found';
}
export class ApiDependencyError extends ApiError {
    override readonly kind = 'dependency' as const;
}
export class ApiUnavailableError extends ApiError {
    override readonly kind = 'unavailable' as const;
}
export class ApiDependencyTimeoutError extends ApiError {
    override readonly kind = 'dependency-timeout' as const;
}

/** A bug or invalid implementation state. Local errors become server errors only after a remote decode. */
export class ApiImplementationError extends ApiError {
    override readonly kind = 'implementation' as const;

    constructor(
        message: string,
        cause?: Error,
        public readonly serverError = false,
    ) {
        super(message, cause);
    }
}

export class ApiRateLimitedError extends ApiError {
    override readonly kind = 'rate-limited' as const;
}
export class ApiForbiddenError extends ApiError {
    override readonly kind = 'forbidden' as const;
}
export class ApiRequestTimeoutError extends ApiError {
    override readonly kind = 'request-timeout' as const;
}

/** A caller-local connection failure. HTTP servers normalize this to ApiImplementationError. */
export class ApiConnectionError extends ApiError {
    override readonly kind = 'connection' as const;
}

/** The API operation is missing, distinct from an absent domain entity. */
export class ApiEndpointNotFoundError extends ApiNotFoundError {
    override readonly kind = 'endpoint-not-found' as const;
}

/** Expected end-user mistake. Its message is deliberately caller-safe. */
export class ApiEndUserError extends ApiError {
    override readonly kind = 'end-user' as const;

    constructor(
        message: string,
        public errorCode?: string,
        cause?: Error,
    ) {
        super(message, cause);
        this.subType = 'USER_ERROR';
    }
}

/** Invalid API caller input. message is diagnostic; callerMessage is safe to publish. */
export class ApiBadRequestError extends ApiError {
    override readonly kind = 'bad-request' as const;

    constructor(
        message: string,
        public field?: string,
        public callerMessage?: string,
        cause?: Error,
    ) {
        super(message, cause);
    }
}

export class ApiUnauthorizedError extends ApiError {
    override readonly kind = 'unauthorized' as const;

    constructor(message: string, subType?: string, cause?: Error) {
        super(message, cause);
        this.subType = subType;
    }
}

export class ApiDependencyBackoffError extends ApiError {
    override readonly kind = 'dependency-backoff' as const;

    constructor(
        message: string,
        public retryAfterSeconds = 30,
        cause?: Error,
    ) {
        super(message, cause);
    }
}
