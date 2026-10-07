import { AuthorizationEndpointErrorCode, OAuthText } from './OAuthErrorCode';

/**
 * The AUTHORIZATION endpoint's error answer, RFC 6749 §4.1.2.1: not a status code at all, but a
 * redirect of the user agent back to the client's `redirect_uri` carrying
 * `error`, `error_description?`, `error_uri?`, `state` and (RFC 9207) `iss?` as query parameters.
 *
 * ```ts
 * const url = new OAuthAuthorizationErrorRedirect(
 *     client.redirectUri, OAuthErrorCode.ACCESS_DENIED, requestState, 'The user declined',
 * ).toUrl();
 * res.redirect(302, url);
 * ```
 *
 * `requestState` above is the request's `state` narrowed to `string | undefined` (express types a
 * query value more widely). `state` is a REQUIRED argument that may be `undefined`: the RFC requires it back exactly when the
 * client sent it, so every caller must hand over what the request carried rather than forget it.
 * An existing query on `redirectUri` is kept, as the RFC requires.
 *
 * Only redirect to a `redirect_uri` you have VALIDATED against the client's registration. When the
 * `redirect_uri` or `client_id` is missing, invalid or mismatched, RFC 6749 §4.1.2.1 forbids the
 * redirect (it would be an open redirector) — answer the resource owner directly instead, for
 * example with an `OAuthProtocolError` rendered as JSON.
 */
export class OAuthAuthorizationErrorRedirect {
    constructor(
        public readonly redirectUri: string,
        public readonly error: AuthorizationEndpointErrorCode,
        public readonly state: string | undefined,
        public readonly description?: string,
        public readonly errorUri?: string,
        /** RFC 9207 `iss`: the authorization server's issuer identifier, for mix-up defence. */
        public readonly issuer?: string,
    ) {}

    /** The absolute redirect URL. Throws `TypeError` (from `URL`) if `redirectUri` is not absolute. */
    toUrl(): string {
        const url = new URL(this.redirectUri);
        url.searchParams.set('error', this.error);
        if (this.description !== undefined) {
            url.searchParams.set('error_description', OAuthText.sanitize(this.description));
        }
        if (this.errorUri !== undefined) url.searchParams.set('error_uri', this.errorUri);
        if (this.state !== undefined) url.searchParams.set('state', this.state);
        if (this.issuer !== undefined) url.searchParams.set('iss', this.issuer);
        return url.toString();
    }
}
