import {
    ProtocolError,
    ClientRegistry,
    HttpHeader,
    HttpResponseDto,
    HttpResponseStatus,
    WEBPIECES_DEFAULT_ERROR_TRANSLATORS,
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
 * The symmetry is in the TYPE and the structured fields, NOT in the prose: the server sends the real
 * `Error.message` for `HttpUserError` alone and a generic reason phrase for everything else. See
 * {@link WEBPIECES_DEFAULT_ERROR_TRANSLATORS} and, on the server, `HttpErrorWireMapper`.
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
     * {@link WEBPIECES_DEFAULT_ERROR_TRANSLATORS}, which stays the generic default. Symmetric with the server's
     * ExpressWrapper.handleError(), which consults ClientRegistry.tryTranslateToWire() first.
     *
     * @param response - Fetch Response object
     * @param protocolError - Parsed ProtocolError from response body
     * @returns the chosen error plus its provenance and the downstream status
     */
    // webpieces-disable no-function-outside-class -- pure, stateless status-to-type mapping with nothing to inject, called from a BROWSER bundle where no DI container exists; static is the established idiom of this class
    static translateError(response: Response, protocolError: ProtocolError): TranslatedFailure {
        const statusCode = response.status;
        const responseDto = new HttpResponseDto(
            new HttpResponseStatus(statusCode, response.statusText),
            ClientErrorTranslator.readHeaders(response.headers),
            protocolError,
        );

        const custom = ClientRegistry.tryTranslateFromWire(responseDto);
        if (custom !== undefined) {
            return new TranslatedFailure(custom, true, statusCode);
        }

        return new TranslatedFailure(
            WEBPIECES_DEFAULT_ERROR_TRANSLATORS.fromWire(responseDto),
            false,
            statusCode,
        );
    }

    // webpieces-disable no-function-outside-class -- transport normalization belongs beside the static isomorphic translation entry point; neither has state or a DI container in the browser
    private static readHeaders(headers: Headers | undefined): readonly HttpHeader[] {
        if (headers === undefined) {
            return [];
        }
        const result: HttpHeader[] = [];
        headers.forEach((value: string, name: string) => {
            if (name.toLowerCase() !== 'set-cookie') {
                result.push(new HttpHeader(name, value));
            }
        });
        for (const cookie of headers.getSetCookie()) {
            result.push(new HttpHeader('set-cookie', cookie));
        }
        return result;
    }
}
