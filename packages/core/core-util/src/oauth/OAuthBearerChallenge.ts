import { BearerErrorCode, OAuthText } from './OAuthErrorCode';

/**
 * Builds the RFC 6750 §3 `WWW-Authenticate: Bearer ...` value a protected resource answers a refused
 * bearer token with:
 *
 * ```ts
 * new OAuthBearerChallenge(OAuthErrorCode.INVALID_TOKEN, 'The access token expired', undefined, 'mcp').toHeaderValue();
 * // Bearer realm="mcp", error="invalid_token", error_description="The access token expired"
 * ```
 *
 * `error` is `undefined` for a request that carried NO credential at all: RFC 6750 §3.1 says such a
 * challenge SHOULD NOT include an error code. `resourceMetadata` is the RFC 9728 attribute MCP
 * clients follow to discover the authorization server. Every attribute value is sanitized to the
 * RFC's quoted-string character set, so app text can never break the header.
 */
export class OAuthBearerChallenge {
    constructor(
        public readonly error: BearerErrorCode | undefined,
        public readonly description?: string,
        /** Space-delimited scopes the resource requires (RFC 6750 `scope`), for `insufficient_scope`. */
        public readonly scope?: string,
        public readonly realm?: string,
        /** RFC 9728 `resource_metadata`: the protected-resource metadata URL. */
        public readonly resourceMetadata?: string,
    ) {}

    toHeaderValue(): string {
        const attributes: string[] = [];
        this.add(attributes, 'realm', this.realm);
        this.add(attributes, 'error', this.error);
        this.add(attributes, 'error_description', this.description);
        this.add(attributes, 'scope', this.scope);
        this.add(attributes, 'resource_metadata', this.resourceMetadata);
        return attributes.length === 0 ? 'Bearer' : `Bearer ${attributes.join(', ')}`;
    }

    private add(attributes: string[], name: string, value: string | undefined): void {
        if (value !== undefined) {
            attributes.push(`${name}="${OAuthText.sanitize(value)}"`);
        }
    }
}
