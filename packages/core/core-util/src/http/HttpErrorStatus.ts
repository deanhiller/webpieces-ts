import {
    ApiError, UserError, BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError,
    RequestTimeoutError, TooManyRequestsError, BadGatewayError, ServiceUnavailableError,
    GatewayTimeoutError, VendorError,
} from '../errors/ApiError';
import { HttpError } from './errors';

/** HTTP-only adapter: semantic errors themselves have no protocol status property. */
export class HttpErrorStatus {
    // webpieces-disable no-function-outside-class -- stateless mapping shared by HTTP adapters
    static code(error: ApiError): number {
        if (error instanceof HttpError) return error.code;
        if (error instanceof UserError) return 266;
        if (error instanceof BadRequestError) return 400;
        if (error instanceof UnauthorizedError) return 401;
        if (error instanceof ForbiddenError) return 403;
        if (error instanceof NotFoundError) return 404;
        if (error instanceof RequestTimeoutError) return 408;
        if (error instanceof TooManyRequestsError) return 429;
        if (error instanceof BadGatewayError) return 502;
        if (error instanceof ServiceUnavailableError) return 503;
        if (error instanceof GatewayTimeoutError) return 504;
        if (error instanceof VendorError) return 598;
        return 500;
    }
}
