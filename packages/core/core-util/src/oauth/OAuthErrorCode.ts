/**
 * The fixed OAuth 2.x error vocabulary. A throw site picks a member; it cannot invent a code (an
 * `invalid_credential` that no OAuth client understands) because the type has no such member.
 *
 * Sources, by the endpoint that answers with them:
 * - RFC 6749 §5.2, the TOKEN endpoint: `invalid_request`, `invalid_client`, `invalid_grant`,
 *   `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`.
 * - RFC 6750 §3.1, a PROTECTED RESOURCE (bearer token): `invalid_request`, `invalid_token`,
 *   `insufficient_scope`.
 * - RFC 6749 §4.1.2.1, the AUTHORIZATION endpoint (answered as a redirect, see
 *   `OAuthAuthorizationErrorRedirect`): `invalid_request`, `unauthorized_client`, `access_denied`,
 *   `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable`.
 * - RFC 7591 §3.2.2, DYNAMIC CLIENT REGISTRATION (which MCP clients use to register themselves):
 *   `invalid_redirect_uri`, `invalid_client_metadata`, `invalid_software_statement`,
 *   `unapproved_software_statement`.
 *
 * A string enum, every member initialised with its wire value, per the one-spelling rule for API
 * vocabularies in this repo.
 */
export enum OAuthErrorCode {
    INVALID_REQUEST = 'invalid_request',
    INVALID_CLIENT = 'invalid_client',
    INVALID_GRANT = 'invalid_grant',
    UNAUTHORIZED_CLIENT = 'unauthorized_client',
    UNSUPPORTED_GRANT_TYPE = 'unsupported_grant_type',
    INVALID_SCOPE = 'invalid_scope',
    INVALID_TOKEN = 'invalid_token',
    INSUFFICIENT_SCOPE = 'insufficient_scope',
    ACCESS_DENIED = 'access_denied',
    UNSUPPORTED_RESPONSE_TYPE = 'unsupported_response_type',
    SERVER_ERROR = 'server_error',
    TEMPORARILY_UNAVAILABLE = 'temporarily_unavailable',
    INVALID_REDIRECT_URI = 'invalid_redirect_uri',
    INVALID_CLIENT_METADATA = 'invalid_client_metadata',
    INVALID_SOFTWARE_STATEMENT = 'invalid_software_statement',
    UNAPPROVED_SOFTWARE_STATEMENT = 'unapproved_software_statement',
}

/** Every status an OAuth error is answered with when it is rendered as JSON. */
export type OAuthHttpStatus = 400 | 401 | 403 | 500 | 503;

/**
 * The two statuses RFC 6749 §5.2 permits for `invalid_client`: 401 by default, and REQUIRED (with a
 * `WWW-Authenticate` header) when the client authenticated through the `Authorization` header; 400
 * is allowed otherwise. It is the ONLY code whose status the RFCs leave to the server.
 */
export type InvalidClientStatus = 400 | 401;

/** Every code whose status is fixed by the RFCs — all of them except `invalid_client`. */
export type OAuthFixedStatusErrorCode = Exclude<OAuthErrorCode, OAuthErrorCode.INVALID_CLIENT>;

/** The codes RFC 6750 §3.1 defines for a `WWW-Authenticate: Bearer` challenge. */
export type BearerErrorCode =
    | OAuthErrorCode.INVALID_REQUEST
    | OAuthErrorCode.INVALID_TOKEN
    | OAuthErrorCode.INSUFFICIENT_SCOPE;

/** The codes RFC 6749 §4.1.2.1 defines for the authorization endpoint's error redirect. */
export type AuthorizationEndpointErrorCode =
    | OAuthErrorCode.INVALID_REQUEST
    | OAuthErrorCode.UNAUTHORIZED_CLIENT
    | OAuthErrorCode.ACCESS_DENIED
    | OAuthErrorCode.UNSUPPORTED_RESPONSE_TYPE
    | OAuthErrorCode.INVALID_SCOPE
    | OAuthErrorCode.SERVER_ERROR
    | OAuthErrorCode.TEMPORARILY_UNAVAILABLE;

/**
 * The status each fixed code is answered with. The RFCs fix the token-endpoint and bearer codes;
 * the authorization-endpoint codes are normally a REDIRECT, not a status, so their status here is
 * only used when one is rendered as JSON (an authorization request whose `redirect_uri` could not be
 * trusted, where RFC 6749 §4.1.2.1 forbids redirecting): the closest HTTP meaning of each.
 */
export class OAuthErrorStatus {
    // webpieces-disable no-function-outside-class -- pure, exhaustive code -> status table
    static of(code: OAuthFixedStatusErrorCode): OAuthHttpStatus {
        switch (code) {
            case OAuthErrorCode.INVALID_TOKEN:
                return 401;
            case OAuthErrorCode.INSUFFICIENT_SCOPE:
            case OAuthErrorCode.ACCESS_DENIED:
                return 403;
            case OAuthErrorCode.SERVER_ERROR:
                return 500;
            case OAuthErrorCode.TEMPORARILY_UNAVAILABLE:
                return 503;
            case OAuthErrorCode.INVALID_REQUEST:
            case OAuthErrorCode.INVALID_GRANT:
            case OAuthErrorCode.UNAUTHORIZED_CLIENT:
            case OAuthErrorCode.UNSUPPORTED_GRANT_TYPE:
            case OAuthErrorCode.INVALID_SCOPE:
            case OAuthErrorCode.UNSUPPORTED_RESPONSE_TYPE:
            case OAuthErrorCode.INVALID_REDIRECT_URI:
            case OAuthErrorCode.INVALID_CLIENT_METADATA:
            case OAuthErrorCode.INVALID_SOFTWARE_STATEMENT:
            case OAuthErrorCode.UNAPPROVED_SOFTWARE_STATEMENT:
                return 400;
        }
    }
}

/**
 * RFC 6749 restricts `error_description` (and RFC 6750 every quoted challenge attribute) to
 * printable ASCII without `"` and `\` (%x20-21 / %x23-5B / %x5D-7E). Anything else is replaced with
 * `?` at RENDER time — the error itself keeps the original text for the operator log — so an app's
 * description can never break a header or the RFC's character set.
 */
export class OAuthText {
    // webpieces-disable no-function-outside-class -- pure character-set filter shared by every OAuth renderer
    static sanitize(value: string): string {
        return value.replace(/[^\x20-\x21\x23-\x5B\x5D-\x7E]/g, '?');
    }
}
