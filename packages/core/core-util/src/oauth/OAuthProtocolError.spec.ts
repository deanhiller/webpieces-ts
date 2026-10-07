import { describe, it, expect } from 'vitest';
import { ApiMethodInfo } from '../http/ApiMethodInfo';
import { HttpHeader } from '../http/HttpResponseDto';
import { WebpiecesDefaultErrorTranslator } from '../http/WebpiecesDefaultErrorTranslator';
import { WebpiecesDefaultFailureClassifier } from '../http/WebpiecesDefaultFailureClassifier';
import { OAuthAuthorizationErrorRedirect } from './OAuthAuthorizationErrorRedirect';
import { OAuthBearerChallenge } from './OAuthBearerChallenge';
import { OAuthErrorCode, OAuthFixedStatusErrorCode } from './OAuthErrorCode';
import { OAuthErrorResponse } from './OAuthErrorResponse';
import { OAuthErrorExtras, OAuthProtocolError } from './OAuthProtocolError';

class StatusCase {
    constructor(
        public readonly code: OAuthFixedStatusErrorCode,
        public readonly status: number,
    ) {}
}

// webpieces-disable no-function-outside-class -- tiny header lookup for assertions
function header(headers: readonly HttpHeader[], name: string): string | undefined {
    return headers.find((h: HttpHeader) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

describe('OAuthProtocolError status derivation (#1176)', () => {
    const cases = [
        new StatusCase(OAuthErrorCode.INVALID_REQUEST, 400),
        new StatusCase(OAuthErrorCode.INVALID_GRANT, 400),
        new StatusCase(OAuthErrorCode.UNAUTHORIZED_CLIENT, 400),
        new StatusCase(OAuthErrorCode.UNSUPPORTED_GRANT_TYPE, 400),
        new StatusCase(OAuthErrorCode.INVALID_SCOPE, 400),
        new StatusCase(OAuthErrorCode.INVALID_TOKEN, 401),
        new StatusCase(OAuthErrorCode.INSUFFICIENT_SCOPE, 403),
        new StatusCase(OAuthErrorCode.ACCESS_DENIED, 403),
        new StatusCase(OAuthErrorCode.UNSUPPORTED_RESPONSE_TYPE, 400),
        new StatusCase(OAuthErrorCode.SERVER_ERROR, 500),
        new StatusCase(OAuthErrorCode.TEMPORARILY_UNAVAILABLE, 503),
        new StatusCase(OAuthErrorCode.INVALID_REDIRECT_URI, 400),
        new StatusCase(OAuthErrorCode.INVALID_CLIENT_METADATA, 400),
    ];
    for (const c of cases) {
        it(`${c.code} -> ${c.status}`, () => {
            expect(new OAuthProtocolError(c.code).status).toBe(c.status);
        });
    }

    it('invalid_client defaults to 401 and may be 400, the one RFC-permitted override', () => {
        expect(new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT).status).toBe(401);
        expect(
            new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'x', undefined, 400).status,
        ).toBe(400);
    });

    it('message is the operator text; cause is kept for the log', () => {
        const cause = new Error('signature mismatch');
        const error = new OAuthProtocolError(
            OAuthErrorCode.INVALID_GRANT,
            'code expired',
            new OAuthErrorExtras(undefined, undefined, cause),
        );
        expect(error.message).toBe('OAuth invalid_grant: code expired');
        expect(error.cause).toBe(cause);
        expect(error.name).toBe('OAuthProtocolError');
    });
});

describe('OAuthErrorResponse rendering (#1176)', () => {
    it('renders the RFC JSON shape, no-store, and leaves absent optionals off the body', () => {
        const response = OAuthErrorResponse.toResponse(
            new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT, 'code expired'),
            undefined,
        );
        expect(response.status.code).toBe(400);
        expect(JSON.parse(JSON.stringify(response.body))).toEqual({
            error: 'invalid_grant',
            error_description: 'code expired',
        });
        expect(header(response.headers, 'cache-control')).toBe('no-store');
        expect(header(response.headers, 'pragma')).toBe('no-cache');
        expect(header(response.headers, 'www-authenticate')).toBeUndefined();
    });

    it("sends error_uri and the error's own WWW-Authenticate", () => {
        const challenge = new OAuthBearerChallenge(
            OAuthErrorCode.INVALID_TOKEN,
            'expired',
            undefined,
            'mcp',
            'https://h/.well-known/oauth-protected-resource/mcp',
        ).toHeaderValue();
        const response = OAuthErrorResponse.toResponse(
            new OAuthProtocolError(
                OAuthErrorCode.INVALID_TOKEN,
                'expired',
                new OAuthErrorExtras('https://docs/errors#token', challenge),
            ),
            'Bearer ignored',
        );
        expect(response.status.code).toBe(401);
        expect(response.body.error_uri).toBe('https://docs/errors#token');
        expect(header(response.headers, 'www-authenticate')).toBe(
            'Bearer realm="mcp", error="invalid_token", error_description="expired", ' +
                'resource_metadata="https://h/.well-known/oauth-protected-resource/mcp"',
        );
    });

    it('derives the minimal Bearer challenge for invalid_token / insufficient_scope', () => {
        const response = OAuthErrorResponse.toResponse(
            new OAuthProtocolError(OAuthErrorCode.INSUFFICIENT_SCOPE, 'needs tools:write'),
            undefined,
        );
        expect(response.status.code).toBe(403);
        expect(header(response.headers, 'www-authenticate')).toBe(
            'Bearer error="insufficient_scope", error_description="needs tools:write"',
        );
    });

    it('a 401 without its own challenge takes the boundary default', () => {
        const response = OAuthErrorResponse.toResponse(
            new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'bad secret'),
            'Basic realm="oauth"',
        );
        expect(header(response.headers, 'www-authenticate')).toBe('Basic realm="oauth"');
    });

    it('sanitizes a description to the RFC character set in body and header', () => {
        const response = OAuthErrorResponse.toResponse(
            new OAuthProtocolError(OAuthErrorCode.INVALID_TOKEN, 'bad "quote"\\ é'),
            undefined,
        );
        expect(response.body.error_description).toBe('bad ?quote?? ?');
        expect(header(response.headers, 'www-authenticate')).toBe(
            'Bearer error="invalid_token", error_description="bad ?quote?? ?"',
        );
    });

    it('a bare Bearer challenge for a request with no credential has no error attribute', () => {
        expect(
            new OAuthBearerChallenge(undefined, undefined, undefined, 'mcp').toHeaderValue(),
        ).toBe('Bearer realm="mcp"');
        expect(new OAuthBearerChallenge(undefined).toHeaderValue()).toBe('Bearer');
    });
});

describe('the webpieces default translator and classifier know OAuthProtocolError (#1176)', () => {
    it('toWire answers the RFC shape, not the ApiError envelope', () => {
        const response = new WebpiecesDefaultErrorTranslator().toWire(
            new OAuthProtocolError(
                OAuthErrorCode.UNSUPPORTED_GRANT_TYPE,
                'only authorization_code',
            ),
        );
        expect(response.status.code).toBe(400);
        expect(JSON.parse(JSON.stringify(response.body))).toEqual({
            error: 'unsupported_grant_type',
            error_description: 'only authorization_code',
        });
    });

    it('a server refusing a caller is NOT a failure; server_error still is; a client receiving one is', () => {
        const classifier = new WebpiecesDefaultFailureClassifier();
        const server = new ApiMethodInfo('server', 'OAuthApi', 'token');
        const client = new ApiMethodInfo('client', 'OAuthApi', 'token');
        expect(
            classifier.isFailure(new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT), server),
        ).toBe(false);
        expect(
            classifier.isFailure(new OAuthProtocolError(OAuthErrorCode.SERVER_ERROR), server),
        ).toBe(true);
        expect(
            classifier.isFailure(new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT), client),
        ).toBe(true);
    });
});

describe('OAuthAuthorizationErrorRedirect (RFC 6749 §4.1.2.1)', () => {
    it('builds redirect_uri?error=...&error_description=...&state=... keeping the existing query', () => {
        const url = new URL(
            new OAuthAuthorizationErrorRedirect(
                'https://client.example/cb?keep=1',
                OAuthErrorCode.ACCESS_DENIED,
                'xyz 123',
                'The user declined',
                undefined,
                'https://auth.example',
            ).toUrl(),
        );
        expect(url.origin + url.pathname).toBe('https://client.example/cb');
        expect(url.searchParams.get('keep')).toBe('1');
        expect(url.searchParams.get('error')).toBe('access_denied');
        expect(url.searchParams.get('error_description')).toBe('The user declined');
        expect(url.searchParams.get('state')).toBe('xyz 123');
        expect(url.searchParams.get('iss')).toBe('https://auth.example');
        expect(url.searchParams.has('error_uri')).toBe(false);
    });

    it('omits state only when the request carried none', () => {
        const url = new URL(
            new OAuthAuthorizationErrorRedirect(
                'https://client.example/cb',
                OAuthErrorCode.UNSUPPORTED_RESPONSE_TYPE,
                undefined,
            ).toUrl(),
        );
        expect(url.searchParams.has('state')).toBe(false);
        expect(url.search).toBe('?error=unsupported_response_type');
    });
});
