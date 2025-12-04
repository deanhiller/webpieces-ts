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
    HttpGatewayTimeoutError,
} from '@webpieces/http-api';

/**
 * ClientErrorTranslator - Translates HTTP error responses to HttpError exceptions.
 *
 * This is the CLIENT-SIDE reverse of ExpressWrapper.handleError() on the server.
 * It reconstructs typed HttpError exceptions from ProtocolError JSON responses.
 *
 * Architecture:
 * - Server: HttpError → ExpressWrapper.handleError() → ProtocolError JSON
 * - Client: ProtocolError JSON → ClientErrorTranslator.translateError() → HttpError
 *
 * This achieves symmetric error handling - server throws typed exceptions,
 * client receives typed exceptions.
 */
export class ClientErrorTranslator {
    /**
     * Parse error response and reconstruct appropriate HttpError subclass.
     *
     * Maps HTTP status codes to error types (symmetric with server):
     * - 400 → HttpBadRequestError (with field, guiAlertMessage)
     * - 266 → HttpUserError (with errorCode) - 2xx code for user validation
     * - 401 → HttpUnauthorizedError
     * - 403 → HttpForbiddenError
     * - 404 → HttpNotFoundError
     * - 408 → HttpTimeoutError
     * - 500 → HttpInternalServerError
     * - 502 → HttpBadGatewayError
     * - 504 → HttpGatewayTimeoutError
     * - 598 → HttpVendorError (with waitSeconds) - custom status code
     * - other → generic HttpError
     *
     * @param response - Fetch Response object
     * @param protocolError - Parsed ProtocolError from response body
     * @returns HttpError subclass instance
     */
    static translateError(response: Response, protocolError: ProtocolError): Error {
        const statusCode = response.status;
        const message = protocolError.message || response.statusText || 'Unknown error';
        const subType = protocolError.subType;

        // Map status codes to error types (symmetric with server's ExpressWrapper.handleError())
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

            case 500:
                return new HttpInternalServerError(message);

            case 502:
                return new HttpBadGatewayError(message);

            case 504:
                return new HttpGatewayTimeoutError(message);

            case 598: // HttpVendorError - custom status code for vendor/external service errors
                return new HttpVendorError(message, protocolError.waitSeconds);

            default:
                // Unknown status code - return generic HttpError
                return new Error(` could not translate statusCode=${statusCode}`);
        }
    }
}
