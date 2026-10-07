import {
    InvalidClientStatus,
    OAuthErrorCode,
    OAuthErrorStatus,
    OAuthFixedStatusErrorCode,
    OAuthHttpStatus,
} from './OAuthErrorCode';

/**
 * The optional RFC extras of an {@link OAuthProtocolError}. Data only, so a class.
 *
 * - `errorUri` — RFC 6749 `error_uri`: a page a client DEVELOPER can read about the error.
 * - `wwwAuthenticate` — the `WWW-Authenticate` value to send. Build the Bearer form with
 *   `OAuthBearerChallenge`. When it is omitted for `invalid_token` / `insufficient_scope`, the
 *   renderer derives the minimal `Bearer error="..."` challenge RFC 6750 requires.
 * - `cause` — the underlying failure, for the operator log only; it never reaches the caller.
 */
export class OAuthErrorExtras {
    constructor(
        public readonly errorUri?: string,
        public readonly wwwAuthenticate?: string,
        public readonly cause?: Error,
    ) {}
}

/**
 * A refusal from an app-hosted OAuth endpoint (token, registration, a bearer-protected resource),
 * answered in the RFC shape `{ error, error_description?, error_uri? }` and NOT in the webpieces
 * `ApiError` envelope (#1176).
 *
 * WHY A SEPARATE TYPE: the caller of an OAuth endpoint is an OAuth CLIENT (an MCP client, Claude,
 * any RFC 6749 library), which parses the RFC body and nothing else. And a refused grant is the
 * protocol working as designed, so it is logged as an expected refusal, not as a server ERROR. It is
 * deliberately not an `ApiError`: its wire shape, status rules and audience are all different.
 *
 * THE STATUS IS DERIVED FROM THE CODE ({@link OAuthErrorStatus}); a throw site never types one. The
 * single exception is the single one the RFCs make: `invalid_client` may be 400 or 401 (default 401).
 * That is enforced by the OVERLOADS, not by a runtime check — a status argument only compiles for
 * `invalid_client`, and only 400 or 401 (`OAuthProtocolErrorCompileAssertions` pins both):
 *
 * ```ts
 * throw new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT, 'authorization code expired');
 * throw new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'unknown client', undefined, 400);
 * throw new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT, 'x', undefined, 401); // does not compile
 * ```
 *
 * `description` is the RFC `error_description`: SENT to the caller, and meant for the client
 * developer — never put a secret or an end-user sentence in it. It also forms `message`, which is
 * what the operator log shows.
 *
 * Rendered by `OAuthErrorResponse` — which `WebpiecesDefaultErrorTranslator` (webpieces routes),
 * `OAuthExpressErrorHandler` (raw express routes, @webpieces/http-server) and the MCP server's bearer
 * boundary all use, so every path answers the same bytes.
 */
export class OAuthProtocolError extends Error {
    /** The RFC `error` code. */
    readonly error: OAuthErrorCode;
    /** The HTTP status, derived from `error` (see the class doc). */
    readonly status: OAuthHttpStatus;
    /** The RFC `error_description`, sent to the caller. */
    readonly description?: string;
    /** The RFC `error_uri`, sent to the caller. */
    readonly errorUri?: string;
    /** The `WWW-Authenticate` header value, when the caller must be challenged. */
    readonly wwwAuthenticate?: string;

    constructor(error: OAuthFixedStatusErrorCode, description?: string, extras?: OAuthErrorExtras);
    constructor(
        error: OAuthErrorCode.INVALID_CLIENT,
        description?: string,
        extras?: OAuthErrorExtras,
        status?: InvalidClientStatus,
    );
    constructor(
        error: OAuthErrorCode,
        description?: string,
        extras: OAuthErrorExtras = new OAuthErrorExtras(),
        status?: InvalidClientStatus,
    ) {
        super(description === undefined ? `OAuth ${error}` : `OAuth ${error}: ${description}`, {
            cause: extras.cause,
        });
        this.name = 'OAuthProtocolError';
        this.error = error;
        this.status =
            error === OAuthErrorCode.INVALID_CLIENT ? (status ?? 401) : OAuthErrorStatus.of(error);
        this.description = description;
        this.errorUri = extras.errorUri;
        this.wwwAuthenticate = extras.wwwAuthenticate;
    }

    /** True for a refusal of the CALLER (every 4xx); false for `server_error` / `temporarily_unavailable`. */
    isCallerError(): boolean {
        return this.status < 500;
    }
}
