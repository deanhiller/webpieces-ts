import { describe, expect, it } from 'vitest';
import {
    ApiUnauthorizedError,
    HttpHeader,
    OAuthErrorCode,
    OAuthProtocolError,
} from '@webpieces/core-util';
import { WpMcpErrorTranslator } from './WpMcpErrorTranslator';

const CHALLENGE = 'Bearer resource_metadata="https://h/.well-known/oauth-protected-resource/mcp"';

// webpieces-disable no-function-outside-class -- tiny header lookup for assertions
function header(headers: readonly HttpHeader[], name: string): string | undefined {
    return headers.find((h: HttpHeader) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * The MCP bearer boundary (#1176): an authorization service that refuses a bearer with an RFC 6750
 * code is answered in the RFC shape, and keeps the server's discovery challenge on a 401.
 */
describe('WpMcpErrorTranslator bearer boundary renders OAuthProtocolError', () => {
    const translator = new WpMcpErrorTranslator();

    it('invalid_token: 401, RFC body, and the server challenge carrying resource_metadata', () => {
        const response = translator.toBearerBoundaryResponse(
            new OAuthProtocolError(OAuthErrorCode.INVALID_TOKEN, 'token revoked'),
            CHALLENGE,
        );
        expect(response.status.code).toBe(401);
        expect(JSON.parse(JSON.stringify(response.body))).toEqual({
            error: 'invalid_token',
            error_description: 'token revoked',
        });
        expect(header(response.headers, 'www-authenticate')).toBe(CHALLENGE);
    });

    it('insufficient_scope: 403 with the RFC 6750 Bearer challenge', () => {
        const response = translator.toBearerBoundaryResponse(
            new OAuthProtocolError(OAuthErrorCode.INSUFFICIENT_SCOPE, 'needs tools:write'),
            CHALLENGE,
        );
        expect(response.status.code).toBe(403);
        expect(header(response.headers, 'www-authenticate')).toBe(
            'Bearer error="insufficient_scope", error_description="needs tools:write"',
        );
    });

    it('an ordinary ApiUnauthorizedError keeps the JSON-RPC shaped body', () => {
        const response = translator.toBearerBoundaryResponse(
            new ApiUnauthorizedError('no bearer'),
            CHALLENGE,
        );
        expect(response.status.code).toBe(401);
        expect(JSON.stringify(response.body)).toContain('jsonrpc');
        expect(header(response.headers, 'www-authenticate')).toBe(CHALLENGE);
    });

    it('a request that is not an mcpOAuth(...) one gets a plain 401 with no discovery challenge', () => {
        const plain = translator.toBearerBoundaryResponse(
            new ApiUnauthorizedError('bad jwt'),
            undefined,
        );
        expect(plain.status.code).toBe(401);
        expect(header(plain.headers, 'www-authenticate')).toBeUndefined();
        const oauthShaped = translator.toBearerBoundaryResponse(
            new OAuthProtocolError(OAuthErrorCode.INVALID_TOKEN, 'token revoked'),
            undefined,
        );
        expect(oauthShaped.status.code).toBe(401);
        // RFC 6750's own error challenge, but never the resource_metadata discovery pointer.
        expect(header(oauthShaped.headers, 'www-authenticate')).not.toContain('resource_metadata');
    });
});
