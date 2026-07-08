import { injectable } from 'inversify';
import { AuthConfig, Principal } from '@webpieces/http-routing';

/**
 * TestAuthConfig - a stub {@link AuthConfig} for integration tests. It accepts ANY presented
 * token as a fixed principal and returns a fixed shared secret. Tests bind it via appOverrides
 * (rebinding AuthConfig) so a putHeader/authorization token passes the framework AuthFilter
 * without minting a real JWT.
 *
 * The framework AuthFilter still enforces token PRESENCE before calling verifyJwt, so a call
 * with no credential on an authenticated route still 401s through the same chain.
 */
@injectable()
export class TestAuthConfig extends AuthConfig {
    override verifyJwt(token: string): Principal {
        return new Principal('test-user', { token });
    }

    override verifyOidc(): Promise<void> {
        return Promise.resolve();
    }

    override sharedSecret(): string | undefined {
        return 'test-shared-secret';
    }
}
