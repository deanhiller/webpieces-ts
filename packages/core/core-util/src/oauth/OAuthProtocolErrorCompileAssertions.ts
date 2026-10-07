import { OAuthAuthorizationErrorRedirect } from './OAuthAuthorizationErrorRedirect';
import { OAuthBearerChallenge } from './OAuthBearerChallenge';
import { OAuthErrorCode } from './OAuthErrorCode';
import { OAuthErrorExtras, OAuthProtocolError } from './OAuthProtocolError';

/**
 * COMPILE-TIME assertions for {@link OAuthProtocolError}'s status rule: only `invalid_client` takes
 * a status, and only 400 or 401. Each `@ts-expect-error` fails the build (TS2578) if its line ever
 * starts compiling. A non-spec file on purpose: vitest strips types and tsconfig.lib.json excludes
 * specs, so only a compiled file makes these assertions real.
 */
export class OAuthProtocolErrorCompileAssertions {
    legitimate(): void {
        void new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT);
        void new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT, 'code expired');
        void new OAuthProtocolError(
            OAuthErrorCode.INVALID_TOKEN,
            'expired',
            new OAuthErrorExtras(),
        );
        void new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'unknown client');
        void new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'x', undefined, 400);
        void new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'x', undefined, 401);
        void new OAuthBearerChallenge(OAuthErrorCode.INSUFFICIENT_SCOPE, 'x', 'tools:write');
        void new OAuthAuthorizationErrorRedirect('https://c/cb', OAuthErrorCode.ACCESS_DENIED, 's');
    }

    illegal(): void {
        // @ts-expect-error -- the RFCs fix invalid_grant's status; a status argument does not compile
        void new OAuthProtocolError(OAuthErrorCode.INVALID_GRANT, 'x', undefined, 401);
        // @ts-expect-error -- invalid_client may only be 400 or 401
        void new OAuthProtocolError(OAuthErrorCode.INVALID_CLIENT, 'x', undefined, 403);
        // @ts-expect-error -- a code outside the RFC vocabulary does not compile
        void new OAuthProtocolError('invalid_credential', 'x');
        // @ts-expect-error -- invalid_grant is a token-endpoint code, not a Bearer challenge code
        void new OAuthBearerChallenge(OAuthErrorCode.INVALID_GRANT);
        // @ts-expect-error -- invalid_token is not an authorization-endpoint redirect code
        void new OAuthAuthorizationErrorRedirect('https://c/cb', OAuthErrorCode.INVALID_TOKEN, 's');
    }
}
