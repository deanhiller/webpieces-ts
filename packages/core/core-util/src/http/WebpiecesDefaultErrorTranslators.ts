import {
    ProtocolError,
    HttpError,
    HttpBadRequestError,
    HttpUserError,
    HttpVendorError,
    HttpUnauthorizedError,
    HttpForbiddenError,
    HttpNotFoundError,
    HttpTimeoutError,
    HttpInternalServerError,
    HttpBadGatewayError,
    HttpServiceUnavailableError,
    HttpGatewayTimeoutError,
    HttpTooManyRequestsError,
} from './errors';
import { ErrorTranslators } from './ErrorTranslators';
import { HttpHeader, HttpResponseDto, HttpResponseStatus } from './HttpResponseDto';
import { HttpErrorWireMapper } from './HttpErrorWireMapper';
import { LogManager } from '../logging/LogManager';

/** Delegable default policy. Request-id propagation belongs to the server transport. */
export class WebpiecesDefaultErrorTranslators implements ErrorTranslators {
    private readonly mapper = new HttpErrorWireMapper();
    toWire(error: Error): HttpResponseDto {
        let body: ProtocolError;
        let code: number;
        if (error instanceof HttpError) {
            body = this.mapper.toWire(error);
            code = error.code;
        } else {
            LogManager.getLogger('WebpiecesDefaultErrorTranslators').error(
                'Unexpected error:',
                error,
            );
            body = new ProtocolError();
            body.message = 'Internal Server Error';
            code = 500;
        }
        return new HttpResponseDto(
            new HttpResponseStatus(
                code,
                code === 266 ? 'User Error' : this.mapper.genericMessage(code),
            ),
            [new HttpHeader('Content-Type', 'application/json')],
            body,
        );
    }
    /** Reconstruct the built-in type and structured fields. */
    fromWire(response: HttpResponseDto): Error {
        const statusCode = response.status.code;
        const protocolError =
            response.body !== null && typeof response.body === 'object'
                ? (response.body as ProtocolError)
                : new ProtocolError();
        const message = protocolError.message || response.status.reason || 'Unknown error';
        const subType = protocolError.subType;

        switch (statusCode) {
            case 400:
                return new HttpBadRequestError(
                    message,
                    protocolError.field,
                    protocolError.guiAlertMessage,
                );

            case 266: // HttpUserError - 2xx code for user validation errors
                return new HttpUserError(message, protocolError.errorCode);

            case 401:
                return new HttpUnauthorizedError(message, subType);

            case 403:
                return new HttpForbiddenError(message);

            case 404:
                return new HttpNotFoundError(message);

            case 408:
                return new HttpTimeoutError(message);

            case 429:
                // The server has always been able to throw this (HttpErrorWireMapper sends
                // 'Too Many Requests' for it); the client had no case for it, so it arrived as a bare
                // HttpError and callers were pushed back to `err.code === 429` — the untyped pattern
                // this ladder exists to replace. That gap bites harder now that `message` is a
                // constant per status: branching on the TYPE is the only thing left, so every status
                // the server can emit needs one.
                return new HttpTooManyRequestsError(message);

            case 500:
                return new HttpInternalServerError(message);

            case 502:
                return new HttpBadGatewayError(message);

            case 503:
                return new HttpServiceUnavailableError(message);

            case 504:
                return new HttpGatewayTimeoutError(message);

            case 598: // HttpVendorError - custom status code for vendor/external service errors
                return new HttpVendorError(message, protocolError.waitSeconds);

            default:
                // Unknown status code and no app translation claimed it: still a real HttpError (so
                // `err instanceof HttpError` holds after the RPC hop), carrying the status code.
                return new HttpError(
                    message || `could not translate statusCode=${statusCode}`,
                    statusCode,
                    subType,
                );
        }
    }
}

/** Wrap this object to customize part of the default policy. */
export const WEBPIECES_DEFAULT_ERROR_TRANSLATORS = new WebpiecesDefaultErrorTranslators();
