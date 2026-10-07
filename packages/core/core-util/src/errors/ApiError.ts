import { ApiCallSite } from './ApiCallSite';

export type ApiErrorKind =
    | 'end-user'
    | 'bad-request'
    | 'unauthorized'
    | 'forbidden'
    | 'not-found'
    | 'endpoint-not-found'
    | 'request-timeout'
    | 'rate-limited'
    | 'conflict'
    | 'unprocessable'
    | 'precondition-failed'
    | 'unsupported-media-type'
    | 'not-implemented'
    | 'coded'
    | 'implementation'
    | 'dependency'
    | 'bad-gateway'
    | 'unavailable'
    | 'dependency-timeout'
    | 'dependency-backoff'
    | 'connection';

/** Category for portable API failures. Concrete subclasses alone define protocol mappings. */
export abstract class ApiError extends Error {
    abstract readonly kind: ApiErrorKind;
    public subType?: string;

    /**
     * Where the app called the generated client method that rejected with this error — present only
     * on an error a generated api client (HTTP, IPC or Cloud Tasks) rejected with. Set by
     * {@link ApiCallSite.attachTo} as a NON-ENUMERABLE own property, so it never reaches JSON or a
     * structured log; `declare` emits no field, so an error that never failed a client call carries
     * no `callSite` key at all. See {@link ApiCallSite} for why it is not `cause`.
     */
    declare readonly callSite?: ApiCallSite;

    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = new.target.name;
    }
}

export class ApiNotFoundError extends ApiError {
    override readonly kind: ApiErrorKind = 'not-found';
}
export class ApiDependencyError extends ApiError {
    override readonly kind: ApiErrorKind = 'dependency';
}
/** A retry-eligible HTTP 502/proxy failure, distinct from a generic dependency defect. */
export class ApiBadGatewayError extends ApiDependencyError {
    override readonly kind = 'bad-gateway' as const;
}
export class ApiUnavailableError extends ApiDependencyError {
    override readonly kind = 'unavailable' as const;
}
export class ApiDependencyTimeoutError extends ApiDependencyError {
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

/**
 * A caller-local connection failure. HTTP servers normalize this to ApiImplementationError.
 *
 * `message` is the developer text (it names the url and the transport's own reason); `userMessage`
 * is the stable text an app renders verbatim to an end user, matching `ApiCallTimeoutError.userMessage`
 * so the two transport failures read consistently.
 */
export class ApiConnectionError extends ApiError {
    static readonly USER_MESSAGE =
        "We couldn't reach the server. Please check your network connection and try again.";

    override readonly kind = 'connection' as const;
    /** End-user text; `message` stays the developer text. */
    readonly userMessage: string = ApiConnectionError.USER_MESSAGE;
}

/** The API operation is missing, distinct from an absent domain entity. */
export class ApiEndpointNotFoundError extends ApiNotFoundError {
    override readonly kind = 'endpoint-not-found' as const;
}

/**
 * The HTTP status an API EDGE answers for an {@link ApiEndUserError}. End-user outcomes only, so
 * nobody tunnels a 5xx/401/403/429 through the end-user channel (auth, rate limiting and dependency
 * failure keep their own types). Extend deliberately.
 */
export type EdgeHttpStatus = 400 | 404 | 409 | 422;

/**
 * Expected mistake by the ACTOR driving the call: the input was well-formed but wrong in a way the actor
 * must fix (for example "the two passwords you entered do not match"). The actor may be a human user in
 * a GUI OR an LLM calling an MCP tool; the same class serves both. Its message is deliberately
 * caller-safe and is the only ApiError message published verbatim: `ApiErrorCodec` keeps it (and
 * `errorCode`) across every remote hop, so a downstream service's text reaches the GUI or the model
 * byte-for-byte.
 *
 * `edgeHttpStatus` travels the same way. It is what a partner-facing API edge (an http-server router
 * in `'edge'` end-user-status mode) answers instead of 266, so one throw site serves both a GUI and a
 * published REST contract: `throw new ApiEndUserError('That report does not exist', 'report_not_found', 404)`.
 * GUI edges ignore it and keep answering 266.
 */
export class ApiEndUserError extends ApiError {
    override readonly kind = 'end-user' as const;

    constructor(
        message: string,
        public errorCode?: string,
        public edgeHttpStatus?: EdgeHttpStatus,
        cause?: Error,
    ) {
        super(message, cause);
        this.subType = 'USER_ERROR';
    }

    /** Narrows a dynamic value (for example one read off the wire) to a legal {@link EdgeHttpStatus}. */
    // webpieces-disable no-function-outside-class -- stateless status guard; webpieces-disable no-any-unknown -- wire values are narrowed here
    static isEdgeHttpStatus(value: unknown): value is EdgeHttpStatus {
        return value === 400 || value === 404 || value === 409 || value === 422;
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

export class ApiDependencyBackoffError extends ApiDependencyError {
    override readonly kind = 'dependency-backoff' as const;

    constructor(
        message: string,
        public retryAfterSeconds = 30,
        cause?: Error,
    ) {
        super(message, cause);
    }
}

/** The request conflicts with the current state of the target resource (HTTP 409). */
export class ApiConflictError extends ApiError {
    override readonly kind = 'conflict' as const;
}

/** The request was well-formed but semantically unprocessable (HTTP 422). */
export class ApiUnprocessableError extends ApiError {
    override readonly kind = 'unprocessable' as const;
}

/** A caller-supplied precondition (for example If-Match) did not hold (HTTP 412). */
export class ApiPreconditionFailedError extends ApiError {
    override readonly kind = 'precondition-failed' as const;
}

/** The request body is in a media type this operation does not accept (HTTP 415). */
export class ApiUnsupportedMediaTypeError extends ApiError {
    override readonly kind = 'unsupported-media-type' as const;
}

/** The operation exists in the contract but this server does not implement it (HTTP 501). */
export class ApiNotImplementedError extends ApiError {
    override readonly kind = 'not-implemented' as const;
}

/** Builds the tuple [0, 1, ..., N-1]; tail-recursive so TypeScript can reach 600. */
type StatusRange<N extends number, Acc extends number[] = []> = Acc['length'] extends N
    ? Acc
    : StatusRange<N, [...Acc, Acc['length']]>;

/**
 * Every integer from 100 through 599 as a literal union. `new ApiCodedError(msg, 600)`,
 * `new ApiCodedError(msg, 99)` and `new ApiCodedError(msg, 404.5)` do not compile; a dynamic
 * `number` must be narrowed with {@link ApiCodedError.isStatusCode} first.
 */
export type ApiStatusCode = Exclude<StatusRange<600>[number], StatusRange<100>[number]>;

/**
 * Catch-all carrying an explicit protocol status for outcomes no named ApiError covers. Any code in
 * 100-599 is accepted, including one a named class already owns. `statusCode` and `errorCode` survive
 * every remote hop through `ApiErrorCodec`; `message` stays operator-only like every other non
 * end-user kind. A status below 500 is a caller outcome (except 408 and 429, which mirror
 * `ApiRequestTimeoutError` and `ApiRateLimitedError`); 500 and above is a server/dependency fault.
 */
export class ApiCodedError extends ApiError {
    override readonly kind = 'coded' as const;

    constructor(
        message: string,
        public readonly statusCode: ApiStatusCode,
        public errorCode?: string,
        cause?: Error,
    ) {
        super(message, cause);
    }

    /** Narrows a dynamic number (for example one read off the wire) to a legal status code. */
    // webpieces-disable no-function-outside-class -- stateless status guard; webpieces-disable no-any-unknown -- wire and app values are narrowed here
    static isStatusCode(value: unknown): value is ApiStatusCode {
        return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
    }

    /** True when the status describes the caller's mistake rather than a fault on the serving side. */
    isCallerError(): boolean {
        return this.statusCode < 500 && this.statusCode !== 408 && this.statusCode !== 429;
    }
}

/**
 * The CALLER's build is too old for this server: HTTP **426 Upgrade Required**, errorCode
 * {@link ApiClientTooOldError.CODE}. It means "upgrade", never "bug".
 *
 * WHO THROWS IT: a server gate that compares the build the caller DECLARED (a header, a version in
 * the request) against the minimum this server still supports. Every webpieces client and server
 * deployed separately hits this skew (a browser tab left open across a release, a mobile WebView
 * pinned to an old bundle), and only the SERVER can tell that its caller is too old.
 *
 * WHY 426 AND NOT 266: a 266 means "the user must fix something" and its message is shown verbatim,
 * so a bundle built before the gate existed would print the server's developer text as a user
 * instruction. A non-266 status reaches every bundle already in the field as a non-user failure.
 *
 * WHAT RECEIVERS DO: `ReceivedApiErrorRule` decodes it back into THIS type on every hop
 * (server-to-server and browser, HTTP and IPC) instead of the `ApiImplementationError` an ordinary
 * received 4xx becomes. A client treats it as "reload / install the new build", never as a red bug
 * dialog. It pairs with `allowUpgradeInFlight` (`HttpEndpointOptions`), which declares which calls
 * an upgrade may cut off: that flag is the client deciding WHEN it may upgrade, this error is the
 * server saying that it MUST.
 *
 * NO user-facing copy: `message` is developer text like every non-end-user kind (it is not published
 * across the wire), and the receiving client owns the wording it shows. The status and the code are
 * FIXED here, so a throw site cannot send a 426 that the receivers would not recognise.
 *
 * It is an {@link ApiCodedError} on purpose: the wire form is exactly `kind: 'coded'`,
 * `statusCode: 426`, `errorCode: 'client-too-old'`, which is what an app's own hand-rolled
 * client-too-old error already publishes, so a bundle in the field and a server on the new release
 * agree without either side changing its payload.
 */
export class ApiClientTooOldError extends ApiCodedError {
    /** The fixed `errorCode`; together with status 426 it is what a receiver matches on. */
    static readonly CODE = 'client-too-old';
    /** HTTP 426 Upgrade Required. */
    static readonly STATUS_CODE = 426;

    constructor(message: string, cause?: Error) {
        super(message, ApiClientTooOldError.STATUS_CODE, ApiClientTooOldError.CODE, cause);
    }

    /** True when a coded failure's status and code are this error's wire identity. */
    // webpieces-disable no-function-outside-class -- stateless wire-identity predicate
    static matches(statusCode: number, errorCode: string | undefined): boolean {
        return (
            statusCode === ApiClientTooOldError.STATUS_CODE &&
            errorCode === ApiClientTooOldError.CODE
        );
    }
}
