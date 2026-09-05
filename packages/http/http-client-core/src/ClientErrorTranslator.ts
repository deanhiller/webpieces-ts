import {
    ProtocolError,
    ClientRegistry,
    HttpResponseDto,
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
} from '@webpieces/core-util';
import { TranslatedFailure } from './TranslatedFailure';

/**
 * ClientErrorTranslator - Translates HTTP error responses to HttpError exceptions.
 *
 * This is the CLIENT-SIDE reverse of ExpressWrapper.handleError() on the server.
 * It reconstructs typed HttpError exceptions from ProtocolError JSON responses.
 *
 * Architecture:
 * - Server: HttpError → ExpressWrapper.handleError() → an {@link HttpResponseDto} on the wire
 * - Client: that response → ClientErrorTranslator.translateError() → TranslatedFailure
 *
 * Both sides speak {@link HttpResponseDto}, which is what makes an app's `ErrorTranslators` one
 * object with two halves that can be read against each other: `toWire` produces exactly the shape
 * `fromWire` consumes, whether the reader was `http-client-node` or `http-client-browser`.
 *
 * This achieves symmetric error handling - server throws typed exceptions,
 * client receives typed exceptions.
 *
 * The symmetry is in the TYPE and the structured fields, NOT in the prose: the server sends the real
 * `Error.message` for `HttpUserError` alone and a generic reason phrase for everything else. See
 * {@link builtInError} and, on the server, `HttpErrorWireMapper`.
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
     * The app's `ErrorTranslators` wins, so an app can reconstruct its OWN error types (e.g. a
     * custom 460) AND override built-ins. `undefined` means "not mine" — fall through to
     * {@link builtInError}, which stays the generic default. Symmetric with the server's
     * ExpressWrapper.handleError(), which consults ClientRegistry.tryTranslateToWire() first.
     *
     * @param response - the WHOLE response, normalised out of the transport by
     *   `HttpResponseDtoFactory` — status code, reason phrase, header list and parsed body
     * @returns the chosen error plus its provenance and the downstream status
     */
    // webpieces-disable no-function-outside-class -- pure, stateless status-to-type mapping with nothing to inject, called from a BROWSER bundle where no DI container exists; static is the established idiom of this class
    static translateError(response: HttpResponseDto): TranslatedFailure {
        const statusCode = response.status.code;

        const custom = ClientRegistry.tryTranslateFromWire(response);
        if (custom !== undefined) {
            return new TranslatedFailure(custom, true, statusCode);
        }

        return new TranslatedFailure(
            ClientErrorTranslator.builtInError(response),
            false,
            statusCode,
        );
    }

    /**
     * The built-in status → error mapping (symmetric with the server's ExpressWrapper.handleError()):
     * - 400 → HttpBadRequestError (with field, guiAlertMessage)
     * - 266 → HttpUserError (with errorCode) - 2xx code for user validation
     * - 401 → HttpUnauthorizedError (with subType)
     * - 403 → HttpForbiddenError
     * - 404 → HttpNotFoundError
     * - 408 → HttpTimeoutError
     * - 429 → HttpTooManyRequestsError
     * - 500 → HttpInternalServerError
     * - 502 → HttpBadGatewayError
     * - 503 → HttpServiceUnavailableError
     * - 504 → HttpGatewayTimeoutError
     * - 598 → HttpVendorError (with waitSeconds) - custom status code
     * - other → generic HttpError
     *
     * # What `message` means on THIS side of the wire
     *
     * The reconstructed error carries whatever text the wire carried, and for every status except
     * **266** a webpieces server deliberately sends only the GENERIC reason phrase — 'Not Found',
     * 'Internal Server Error', … See `HttpErrorWireMapper` (http-server) for why: `Error.message` is
     * an operator-facing field that routinely quotes internal detail, so it stays in the server's log
     * and never reaches a caller. `HttpUserError` (266) is the one type whose message was WRITTEN for
     * a human to read, and it arrives verbatim.
     *
     * So: branch on the TYPE, on `subType`, on `errorCode`, or on `guiAlertMessage` — never on the
     * prose of `message`. It is now a constant per status by design, and treating it as diagnostic
     * information will not work against a current webpieces server. The diagnosis lives in the
     * server's logs, correlated by request id.
     *
     * (An app that publishes richer text on purpose does it through
     * `ClientRegistry.setErrorTranslators()`, which is consulted before this mapping on both sides.)
     *
     * PUBLIC, and the client-side twin of `HttpErrorWireMapper.toResponse` being public on the
     * server: the webpieces DEFAULT is delegable, so an app whose `fromWire` claims one status can
     * hand every other status straight back here instead of copying this ladder.
     */
    // webpieces-disable no-function-outside-class -- public delegable default alongside the static above; same reason
    public static builtInError(response: HttpResponseDto): Error {
        const statusCode = response.status.code;
        const protocolError = ClientErrorTranslator.asProtocolError(response.body);
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

    /**
     * The response body as the {@link ProtocolError} this built-in ladder reads.
     *
     * {@link HttpResponseDto.body} is `unknown` because an APP owns the body shape when it installs
     * its own translators. This default does not: a webpieces server always writes a ProtocolError
     * here, and `ResponseBodyReader` has already parsed one. A body that is not an object at all
     * (a bare string from something that is not a webpieces server) degrades to an EMPTY
     * ProtocolError, so the status-to-type mapping below still answers — it never throws on the
     * error path, which is the one path that must not fail.
     */
    // webpieces-disable no-any-unknown -- HttpResponseDto.body is app-owned; this narrows it back to the shape the BUILT-IN ladder reads
    // webpieces-disable no-function-outside-class -- private helper of the statics above; same reason
    private static asProtocolError(body: unknown): ProtocolError {
        if (body instanceof ProtocolError) {
            return body;
        }
        const parsed = new ProtocolError();
        if (typeof body === 'object' && body !== null) {
            Object.assign(parsed, body);
        }
        return parsed;
    }
}
