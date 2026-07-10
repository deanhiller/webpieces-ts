import { injectable } from 'inversify';
import { AuthConfig, AuthValues, SharedSecrets } from '@webpieces/http-routing';
import { ContextTuple, WebpiecesCoreHeaders } from '@webpieces/core-util';

/**
 * The shared-secret VALUES this stub accepts. Copied into legacy-server so its test
 * does not import from the greenfield client-server app.
 */
export const TEST_SHARED_SECRET = 'some-test-key';
export const TEST_SHARED_SECRET_ROTATING = 'some-test-key-rotating';

/**
 * TestAuthConfig - a stub {@link AuthConfig} for integration tests that don't focus on auth. It
 * accepts ANY presented JWT as a fixed admin user, binds a known shared secret, and accepts any
 * OIDC token. Bound via appOverrides so an authorization token passes the framework AuthFilter
 * without minting a real JWT.
 */
@injectable()
export class TestAuthConfig extends AuthConfig {
    readonly sharedSecrets: Record<string, SharedSecrets> = {
        INTERNAL_API_SECRET: new SharedSecrets(TEST_SHARED_SECRET, TEST_SHARED_SECRET_ROTATING),
    };

    override parseJwt(_token: string): AuthValues {
        return new AuthValues('test-user', ['admin'], [new ContextTuple(WebpiecesCoreHeaders.USER_ID, 'test-user')]);
    }

    override verifyOidc(): Promise<void> {
        return Promise.resolve();
    }
}
