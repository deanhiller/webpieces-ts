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

/**
 * Expected mistake by the ACTOR driving the call: the input was well-formed but wrong in a way the actor
 * must fix (for example "the two passwords you entered do not match"). The actor may be a human user in
 * a GUI OR an LLM calling an MCP tool; the same class serves both. Its message is deliberately
 * caller-safe and is the only ApiError message published verbatim: `ApiErrorCodec` keeps it (and
 * `errorCode`) across every remote hop, so a downstream service's text reaches the GUI or the model
 * byte-for-byte.
 */
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

/**
 * Invalid API caller input (malformed, or failed validation). `message` is operator-only diagnostic
 * text and may name internals; it is never published. `callerMessage` (plus `field`) is what a GUI OR
 * an MCP model is shown so it can correct its input, so throw sites that want the caller to
 * self-correct MUST set it.
 */
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
