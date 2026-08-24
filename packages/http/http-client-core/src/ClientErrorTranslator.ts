import {
    ProtocolError,
    ClientRegistry,
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
} from '@webpieces/core-util';
import { TranslatedFailure } from './TranslatedFailure';

/**
 * ClientErrorTranslator - Translates HTTP error responses to HttpError exceptions.
 *
 * This is the CLIENT-SIDE reverse of ExpressWrapper.handleError() on the server.
 * It reconstructs typed HttpError exceptions from ProtocolError JSON responses.
 *
 * Architecture:
 * - Server: HttpError → ExpressWrapper.handleError() → ProtocolError JSON
 * - Client: ProtocolError JSON → ClientErrorTranslator.translateError() → TranslatedFailure
 *
 * This achieves symmetric error handling - server throws typed exceptions,
 * client receives typed exceptions.
 *
 * It returns a {@link TranslatedFailure} rather than a bare `Error` because the mapping is only HALF
 * the decision. It is ISOMORPHIC — the same mapping runs in a browser and in a server — and the two
 * environments must NOT do the same thing with a downstream 4xx (see
 * `ProxyClient.adaptDownstreamFailure`). The wrapper carries the one fact that hook cannot recover
 * on its own: whether the APP claimed this status, or the built-in default did.
 */
export class ClientErrorTranslator {
    /**
     * Parse an error response and decide which error the caller should see, and who decided it.
     *
     * App-registered translations win, so an app can reconstruct its OWN error types (e.g. a custom
     * 460) AND override built-ins. `undefined` means "not mine" — fall through to
     * {@link builtInError}, which stays the generic default. Symmetric with the server's
     * ExpressWrapper.handleError(), which consults ClientRegistry.tryTranslateToWire() first.
     *
     * @param response - Fetch Response object
     * @param protocolError - Parsed ProtocolError from response body
     * @returns the chosen error plus its provenance and the downstream status
     */
    static translateError(response: Response, protocolError: ProtocolError): TranslatedFailure {
        const statusCode = response.status;

        const custom = ClientRegistry.tryTranslateFromWire(statusCode, protocolError);
        if (custom !== undefined) {
            return new TranslatedFailure(custom, true, statusCode);
        }

        return new TranslatedFailure(
            ClientErrorTranslator.builtInError(response, protocolError),
            false,
            statusCode,
        );
    }

    /**
     * The built-in status → error mapping (symmetric with the server's ExpressWrapper.handleError()):
     * - 400 → HttpBadRequestError (with field, guiAlertMessage)
     * - 266 → HttpUserError (with errorCode) - 2xx code for user validation
     * - 401 → HttpUnauthorizedError
     * - 403 → HttpForbiddenError
     * - 404 → HttpNotFoundError
     * - 408 → HttpTimeoutError
     * - 500 → HttpInternalServerError
     * - 502 → HttpBadGatewayError
     * - 503 → HttpServiceUnavailableError
     * - 504 → HttpGatewayTimeoutError
     * - 598 → HttpVendorError (with waitSeconds) - custom status code
     * - other → generic HttpError
     */
    private static builtInError(response: Response, protocolError: ProtocolError): Error {
        const statusCode = response.status;
        const message = protocolError.message || response.statusText || 'Unknown error';
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
