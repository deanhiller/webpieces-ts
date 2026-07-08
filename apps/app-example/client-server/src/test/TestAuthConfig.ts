import { injectable } from 'inversify';
import { AuthConfig, AuthValues, SharedSecrets } from '@webpieces/http-routing';
import { ContextTuple } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';

/**
 * TestAuthConfig - a stub {@link AuthConfig} for integration tests that don't focus on auth. It
 * accepts ANY presented JWT as a fixed admin user, binds a known shared secret ('some-test-key'),
 * and accepts any OIDC token. Bound via appOverrides so a putHeader/authorization token passes the
 * framework AuthFilter without minting a real JWT.
 *
 * The AuthFilter still enforces token PRESENCE before parsing, so a no-credential call on a
 * protected route still 401s through the same chain. Auth-focused tests (Authentication.spec.ts)
 * instead bind the real CompanyAuthConfig with signed tokens / dev OIDC tokens.
 */
@injectable()
export class TestAuthConfig extends AuthConfig {
    // Two accepted values so tests can prove BOTH secret1 and secret2 pass (rotation window).
    readonly sharedSecrets: Record<string, SharedSecrets> = {
        INTERNAL_API_SECRET: new SharedSecrets('some-test-key', 'some-test-key-rotating'),
    };

    override parseJwt(_token: string): AuthValues {
        return new AuthValues('test-user', ['admin'], [new ContextTuple(CompanyHeaders.USER_ID, 'test-user')]);
    }

    override verifyOidc(): Promise<void> {
        return Promise.resolve();
    }
}
