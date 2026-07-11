import { injectable } from 'inversify';
import { AuthConfig, JwtHook, AuthValues, SharedSecrets } from '@webpieces/http-routing';
import { ContextTuple, WebpiecesCoreHeaders } from '@webpieces/core-util';

/**
 * The shared-secret VALUES this stub accepts. Copied into legacy-server so its test
 * does not import from the greenfield client-server app.
 */
export const TEST_SHARED_SECRET = 'some-test-key';
export const TEST_SHARED_SECRET_ROTATING = 'some-test-key-rotating';

/**
 * TestAuthConfig - a stub {@link AuthConfig} (shared-secret STATE) for integration tests that don't
 * focus on auth. It binds a known shared secret; pair it with {@link TestJwtHook} when the test also
 * exercises @AuthJwt endpoints. Bound via appOverrides so an authorization token passes the framework
 * AuthFilter without minting a real JWT.
 */
@injectable()
export class TestAuthConfig extends AuthConfig {
    constructor() {
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
