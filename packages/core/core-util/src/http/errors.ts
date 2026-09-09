import { ApiError } from '../errors/ApiError';
export class ProtocolError {
    public message?: string;
    public subType?: string;
    public field?: string;
    public waitSeconds?: number;
    /**
     * Filled only by an app's own `ErrorTranslators.toWire()`. The built-in HttpError ladder does NOT
     * send it: nothing on the client reads it, and for a subclass it is an internal class name.
     */
    public name?: string;
    public guiAlertMessage?: string;
    public errorCode?: string;
}

// Error subtype constants
export const ENTITY_NOT_FOUND = 'EntityNotFoundError';
export const WRONG_LOGIN_TYPE = 'wrongLoginType';
export const WRONG_LOGIN = 'wronglogin';
export const NOT_APPROVED = 'notapproved';
export const EMAIL_NOT_CONFIRMED = 'email_not_confirmed';
export const WRONG_DOMAIN = 'wrongdomain';
export const WRONG_COMPANY = 'wrongcompany';
export const NO_REG_CODE = 'noregcode';

/** @deprecated Prefer ApiError semantic subclasses; custom HTTP status belongs in ErrorTranslators. */
export class HttpError extends ApiError {
    constructor(
        message: string,
        public code: number,
        subType?: string,
        cause?: Error,
    ) {
        super(message, cause);
        this.subType = subType;
    }
    /** @deprecated Use the standard Error.cause. */
    get httpCause(): Error | undefined {
        return this.cause instanceof Error ? this.cause : undefined;
    }
}
export { EndpointNotFoundError, OfflineError } from '../errors/ApiError';
/** @deprecated Use NotFoundError from @webpieces/core-util/errors. Same constructor identity. */
export { NotFoundError as HttpNotFoundError } from '../errors/ApiError';
/** @deprecated Use BadRequestError from @webpieces/core-util/errors. Same constructor identity. */
export { BadRequestError as HttpBadRequestError } from '../errors/ApiError';
/** @deprecated Use UnauthorizedError from @webpieces/core-util/errors. Same constructor identity. */
export { UnauthorizedError as HttpUnauthorizedError } from '../errors/ApiError';
/** @deprecated Use TooManyRequestsError from @webpieces/core-util/errors. Same constructor identity. */
export { TooManyRequestsError as HttpTooManyRequestsError } from '../errors/ApiError';
/** @deprecated Use ForbiddenError from @webpieces/core-util/errors. Same constructor identity. */
export { ForbiddenError as HttpForbiddenError } from '../errors/ApiError';
/** @deprecated Use RequestTimeoutError from @webpieces/core-util/errors. Same constructor identity. */
export { RequestTimeoutError as HttpTimeoutError } from '../errors/ApiError';
/** @deprecated Use BadGatewayError from @webpieces/core-util/errors. Same constructor identity. */
export { BadGatewayError as HttpBadGatewayError } from '../errors/ApiError';
/** @deprecated Use ServiceUnavailableError from @webpieces/core-util/errors. Same constructor identity. */
export { ServiceUnavailableError as HttpServiceUnavailableError } from '../errors/ApiError';
/** @deprecated Use GatewayTimeoutError from @webpieces/core-util/errors. Same constructor identity. */
export { GatewayTimeoutError as HttpGatewayTimeoutError } from '../errors/ApiError';
/** @deprecated Use InternalError from @webpieces/core-util/errors. Same constructor identity. */
export { InternalError as HttpInternalServerError } from '../errors/ApiError';
/** @deprecated Use VendorError from @webpieces/core-util/errors. Same constructor identity. */
export { VendorError as HttpVendorError } from '../errors/ApiError';
/** @deprecated Use UserError from @webpieces/core-util/errors. Same constructor identity. */
export { UserError as HttpUserError } from '../errors/ApiError';

export {
    NotFoundError,
    BadGatewayError,
    ServiceUnavailableError,
    GatewayTimeoutError,
    InternalError,
    TooManyRequestsError,
    ForbiddenError,
    RequestTimeoutError,
    UserError,
    BadRequestError,
    UnauthorizedError,
    VendorError,
} from '../errors/ApiError';
export { ApiError };
