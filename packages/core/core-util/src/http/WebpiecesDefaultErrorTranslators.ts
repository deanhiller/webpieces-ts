import {
    HttpBadGatewayError,
    HttpBadRequestError,
    HttpError,
    HttpForbiddenError,
    HttpGatewayTimeoutError,
    HttpInternalServerError,
    HttpNotFoundError,
    HttpServiceUnavailableError,
    HttpTimeoutError,
    HttpTooManyRequestsError,
    HttpUnauthorizedError,
    HttpUserError,
    HttpVendorError,
    ProtocolError,
} from './errors';
import { ErrorTranslators } from './ErrorTranslators';
import { HttpResponseDto, HttpResponseStatus } from './HttpResponseDto';

const reasons = new Map<number, string>([
    [266, 'User Error'],
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
    [598, 'Vendor Error'],
]);

/** The public webpieces fallback, exported so applications can delegate from their own translator. */
export class WebpiecesDefaultErrorTranslators implements ErrorTranslators {
    toWire(error: Error): HttpResponseDto {
        const httpError =
            error instanceof HttpError ? error : new HttpInternalServerError(error.message);
        const reason = reasons.get(httpError.code) ?? 'Request Failed';
        const body = new ProtocolError();
        body.message = httpError instanceof HttpUserError ? httpError.message : reason;
        body.subType = httpError.subType;
        if (httpError instanceof HttpUserError) {
            body.errorCode = httpError.errorCode;
        } else if (httpError instanceof HttpBadRequestError) {
            body.field = httpError.field;
            body.guiAlertMessage = httpError.guiMessage;
        } else if (httpError instanceof HttpVendorError) {
            body.waitSeconds = httpError.waitSeconds;
        }
        return new HttpResponseDto(new HttpResponseStatus(httpError.code, reason), [], body);
    }

    fromWire(response: HttpResponseDto): Error {
        const pe = new ProtocolError();
        if (typeof response.body === 'object' && response.body !== null) {
            Object.assign(pe, response.body);
        }
        const message = pe.message || response.status.reason || 'Unknown error';
        switch (response.status.code) {
            case 400:
                return new HttpBadRequestError(message, pe.field, pe.guiAlertMessage);
            case 266:
                return new HttpUserError(message, pe.errorCode);
            case 401:
                return new HttpUnauthorizedError(message, pe.subType);
            case 403:
                return new HttpForbiddenError(message);
            case 404:
                return new HttpNotFoundError(message);
            case 408:
                return new HttpTimeoutError(message);
            case 429:
                return new HttpTooManyRequestsError(message);
            case 500:
                return new HttpInternalServerError(message);
            case 502:
                return new HttpBadGatewayError(message);
            case 503:
                return new HttpServiceUnavailableError(message);
            case 504:
                return new HttpGatewayTimeoutError(message);
            case 598:
                return new HttpVendorError(message, pe.waitSeconds);
            default:
                return new HttpError(message, response.status.code, pe.subType);
        }
    }
}

export const WEBPIECES_DEFAULT_ERROR_TRANSLATORS = new WebpiecesDefaultErrorTranslators();
