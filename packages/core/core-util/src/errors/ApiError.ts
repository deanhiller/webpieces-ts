/** Portable semantic failures. HTTP status mapping belongs to the HTTP adapter. */
export class ApiError extends Error {
    readonly kind: string = 'internal';
    public subType?: string;
    constructor(message: string, cause?: Error) {
        super(message, { cause });
        this.name = new.target.name;
    }
}

/** NotFound failure, independent of transport. */
export class NotFoundError extends ApiError { override readonly kind: string = 'not-found'; }

/** BadGateway failure, independent of transport. */
export class BadGatewayError extends ApiError { override readonly kind: string = 'bad-gateway'; }

/** ServiceUnavailable failure, independent of transport. */
export class ServiceUnavailableError extends ApiError { override readonly kind: string = 'service-unavailable'; }

/** GatewayTimeout failure, independent of transport. */
export class GatewayTimeoutError extends ApiError { override readonly kind: string = 'gateway-timeout'; }

/** Internal failure, independent of transport. */
export class InternalError extends ApiError { override readonly kind: string = 'internal'; }

/** TooManyRequests failure, independent of transport. */
export class TooManyRequestsError extends ApiError { override readonly kind: string = 'too-many-requests'; }

/** Forbidden failure, independent of transport. */
export class ForbiddenError extends ApiError { override readonly kind: string = 'forbidden'; }

/** RequestTimeout failure, independent of transport. */
export class RequestTimeoutError extends ApiError { override readonly kind: string = 'request-timeout'; }

/** Offline failure, independent of transport. */
export class OfflineError extends ApiError { override readonly kind: string = 'offline'; }

/** The API endpoint is missing, distinct from an absent domain entity. */
export class EndpointNotFoundError extends NotFoundError { override readonly kind: string = 'endpoint-not-found'; }
/** Expected user mistake: successful protocol/monitoring outcome; GUI catches this error. */
export class UserError extends ApiError {
    override readonly kind: string = 'user';
    constructor(message: string, public errorCode?: string, cause?: Error) {
        super(message, cause);
        this.subType = 'USER_ERROR';
    }
}
/** Invalid caller input with optional human-safe field feedback. */
export class BadRequestError extends ApiError {
    override readonly kind: string = 'bad-request';
    constructor(message: string, public field?: string, public guiMessage?: string, cause?: Error) {
        super(message, cause);
    }
}
/** Authentication failure with a contract-defined reason. */
export class UnauthorizedError extends ApiError {
    override readonly kind: string = 'unauthorized';
    constructor(message: string, subType?: string, cause?: Error) {
        super(message, cause);
        this.subType = subType;
    }
}
/** Dependency failure with bounded retry advice. */
export class VendorError extends ApiError {
    override readonly kind: string = 'vendor';
    constructor(message: string, public waitSeconds = 30, cause?: Error) {
        super(message, cause);
    }
}
