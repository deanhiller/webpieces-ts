import { injectable } from 'inversify';
import { AuthConfig, AuthValues, SharedSecrets } from '@webpieces/http-routing';
import { ContextTuple } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';

/**
 * The two shared-secret VALUES this stub accepts. Exported so the test drives BOTH sides from the
 * SAME constant: the client sends this exact value and the config below is configured to accept it —
 * proving what the server receives matches what the caller sent.
 */
export const TEST_SHARED_SECRET = 'some-test-key';
export const TEST_SHARED_SECRET_ROTATING = 'some-test-key-rotating';

/**
 * TestAuthConfig - a stub {@link AuthConfig} for integration tests that don't focus on auth. It
 * accepts ANY presented JWT as a fixed admin user, binds a known shared secret
 * ({@link TEST_SHARED_SECRET}), and accepts any OIDC token. Bound via appOverrides so a
 * putHeader/authorization token passes the framework AuthFilter without minting a real JWT.
 *
 * The AuthFilter still enforces token PRESENCE before parsing, so a no-credential call on a
 * protected route still 401s through the same chain. Auth-focused tests (Authentication.spec.ts)
 * instead bind the real CompanyAuthConfig with signed tokens / dev OIDC tokens.
 */
@injectable()
export class TestAuthConfig extends AuthConfig {
    // Two accepted values so tests can prove BOTH secret1 and secret2 pass (rotation window).
    readonly sharedSecrets: Record<string, SharedSecrets> = {
        INTERNAL_API_SECRET: new SharedSecrets(TEST_SHARED_SECRET, TEST_SHARED_SECRET_ROTATING),
    };

    override parseJwt(_token: string): AuthValues {
        return new AuthValues('test-user', ['admin'], [new ContextTuple(CompanyHeaders.USER_ID, 'test-user')]);
    }

    override verifyOidc(): Promise<void> {
        return Promise.resolve();
    }
}
