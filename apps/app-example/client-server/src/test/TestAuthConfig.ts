import { injectable } from 'inversify';
import { AuthConfig, JwtHook, AuthValues, SharedSecrets } from '@webpieces/http-routing';
import { ContextTuple, WebpiecesCoreHeaders } from '@webpieces/core-util';

/**
 * The two shared-secret VALUES this stub accepts. Exported so the test drives BOTH sides from the
 * SAME constant: the client sends this exact value and the config below is configured to accept it —
 * proving what the server receives matches what the caller sent.
 */
export const TEST_SHARED_SECRET = 'some-test-key';
export const TEST_SHARED_SECRET_ROTATING = 'some-test-key-rotating';

/**
 * TestAuthConfig - a stub {@link AuthConfig} (shared-secret STATE) for integration tests that don't
 * focus on auth. It binds a known shared secret ({@link TEST_SHARED_SECRET}); pair it with
 * {@link TestJwtHook} when the test also exercises @AuthJwt endpoints. Bound via appOverrides so a
 * putHeader/authorization token passes the framework AuthFilter without minting a real JWT.
 *
 * The AuthFilter still enforces token PRESENCE before parsing, so a no-credential call on a
 * protected route still 401s through the same chain. Auth-focused tests (Authentication.spec.ts)
 * instead bind the real CompanyAuthConfig / CompanyJwtHook with signed tokens / dev OIDC tokens.
 */
@injectable()
export class TestAuthConfig extends AuthConfig {
    constructor() {
        // Two accepted values so tests can prove BOTH secret1 and secret2 pass (rotation window).
        super({ INTERNAL_API_SECRET: new SharedSecrets(TEST_SHARED_SECRET, TEST_SHARED_SECRET_ROTATING) });
    }
}

/**
 * TestJwtHook - a permissive {@link JwtHook} stub: accepts ANY presented JWT as a fixed admin user,
 * so a non-auth-focused integration test can send an arbitrary bearer token to an @AuthJwt endpoint
 * without minting a real signed JWT. Bound via appOverrides alongside {@link TestAuthConfig}.
 */
@injectable()
export class TestJwtHook extends JwtHook {
    override parseJwt(_token: string): AuthValues {
        return new AuthValues('test-user', ['admin'], [new ContextTuple(WebpiecesCoreHeaders.USER_ID, 'test-user')]);
    }
}
