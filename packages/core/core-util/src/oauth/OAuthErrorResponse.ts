import { HttpHeader, HttpResponseDto, HttpResponseStatus } from '../http/HttpResponseDto';
import { OAuthBearerChallenge } from './OAuthBearerChallenge';
import { OAuthErrorCode, OAuthHttpStatus, OAuthText } from './OAuthErrorCode';
import { OAuthProtocolError } from './OAuthProtocolError';

/**
 * The RFC 6749 §5.2 / RFC 6750 §3 error body: `{ "error": "...", "error_description"?: "...",
 * "error_uri"?: "..." }`. The property names ARE the wire names, snake_case, because an OAuth client
 * parses exactly these keys. An absent optional is left off the JSON entirely.
 */
export class OAuthErrorBody {
    readonly error: OAuthErrorCode;
    readonly error_description?: string;
    readonly error_uri?: string;

    constructor(error: OAuthErrorCode, description?: string, errorUri?: string) {
        this.error = error;
        if (description !== undefined) this.error_description = OAuthText.sanitize(description);
        if (errorUri !== undefined) this.error_uri = errorUri;
    }
}

/**
 * {@link OAuthProtocolError} -> the exact HTTP response. ONE renderer, used by every boundary that
 * can meet one (`WebpiecesDefaultErrorTranslator`, `OAuthExpressErrorHandler`, the MCP bearer
 * boundary), so an OAuth client gets the same bytes whichever path the refusal took.
 *
 * Headers: the error's `WWW-Authenticate` when it has one; otherwise `defaultChallenge` for a 401
 * (the MCP boundary passes its own challenge, which carries `resource_metadata`); otherwise, for
 * `invalid_token` / `insufficient_scope`, the minimal Bearer challenge RFC 6750 §3 requires. Every
 * response also carries `Cache-Control: no-store` and `Pragma: no-cache` (RFC 6749 §5.1), so no
 * intermediary caches an answer about a credential.
 */
export class OAuthErrorResponse {
    private static readonly REASONS: ReadonlyMap<OAuthHttpStatus, string> = new Map<
        OAuthHttpStatus,
        string
    >([
        [400, 'Bad Request'],
        [401, 'Unauthorized'],
        [403, 'Forbidden'],
        [500, 'Internal Server Error'],
        [503, 'Service Unavailable'],
    ]);

    /**
     * @param defaultChallenge - the boundary's own `WWW-Authenticate` for a 401 whose error carries
     *   none, or `undefined` when the boundary has no challenge of its own.
     */
    // webpieces-disable no-function-outside-class -- pure error -> response mapping shared by every boundary
    static toResponse(
        error: OAuthProtocolError,
        defaultChallenge: string | undefined,
    ): HttpResponseDto<OAuthErrorBody> {
        const headers = [
            new HttpHeader('Cache-Control', 'no-store'),
            new HttpHeader('Pragma', 'no-cache'),
        ];
        const challenge = OAuthErrorResponse.challengeFor(error, defaultChallenge);
        if (challenge !== undefined) {
            headers.push(new HttpHeader('WWW-Authenticate', challenge));
        }
        return new HttpResponseDto(
            new HttpResponseStatus(
                error.status,
                OAuthErrorResponse.REASONS.get(error.status) ?? '',
            ),
            headers,
            new OAuthErrorBody(error.error, error.description, error.errorUri),
        );
    }

    // webpieces-disable no-function-outside-class -- pure header choice owned by this renderer
    private static challengeFor(
        error: OAuthProtocolError,
        defaultChallenge: string | undefined,
    ): string | undefined {
        if (error.wwwAuthenticate !== undefined) return error.wwwAuthenticate;
        if (error.status === 401 && defaultChallenge !== undefined) return defaultChallenge;
        if (
            error.error === OAuthErrorCode.INVALID_TOKEN ||
            error.error === OAuthErrorCode.INSUFFICIENT_SCOPE
        ) {
            return new OAuthBearerChallenge(error.error, error.description).toHeaderValue();
        }
        return undefined;
    }
}
