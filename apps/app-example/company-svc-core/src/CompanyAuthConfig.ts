import { injectable } from 'inversify';
import jwt from 'jsonwebtoken';
import { AuthConfig, Principal } from '@webpieces/http-routing';
import { HttpUnauthorizedError, toError } from '@webpieces/core-util';

/**
 * CompanyAuthConfig - the app-provided {@link AuthConfig} bound in the container and injected by
 * the framework AuthFilter. It verifies user JWTs with `jsonwebtoken` (secret from JWT_SECRET)
 * and compares shared secrets from env. OIDC is intentionally not wired here (no example uses
 * @AuthOidc) — a real deployment binds an AuthConfig whose verifyOidc calls
 * @webpieces/gcp-identity verifyOidcFromCallers.
 *
 * Tests rebind AuthConfig via appOverrides (e.g. a stub that accepts a fixed token, or a real
 * CompanyAuthConfig sharing a test signing secret) — that is the whole point of binding it.
 */
@injectable()
export class CompanyAuthConfig extends AuthConfig {
    private readonly jwtSecret = process.env['JWT_SECRET'] ?? 'dev-insecure-jwt-secret-change-me';

    override verifyJwt(token: string): Principal {
        const claims = this.decode(token);
        const subject = claims['sub'] ?? claims['userId'];
        if (subject === undefined || subject === null || subject === '') {
            throw new HttpUnauthorizedError('JWT has no subject (sub/userId) claim');
        }
        return new Principal(String(subject), claims);
    }

    override verifyOidc(_token: string, _callers: string[]): Promise<void> {
        return Promise.reject(
            new HttpUnauthorizedError(
                'OIDC is not wired in this example — bind an AuthConfig whose verifyOidc calls ' +
                    '@webpieces/gcp-identity verifyOidcFromCallers(token, callers).',
            ),
        );
    }

    override sharedSecret(secretEnv: string): string | undefined {
        return process.env[secretEnv];
    }

    // webpieces-disable no-any-unknown -- jwt claims are an arbitrary provider-defined bag
    private decode(token: string): Record<string, unknown> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- jwt.verify throws on a bad token; translated to a managed 401 here
        try {
            const payload = jwt.verify(token, this.jwtSecret);
            if (typeof payload === 'object' && payload !== null) {
                // webpieces-disable no-any-unknown -- jwt payload is an arbitrary claims object
                return payload as Record<string, unknown>;
            }
            return {};
        } catch (err: unknown) {
            const error = toError(err);
            throw new HttpUnauthorizedError('Invalid JWT token', undefined, error);
        }
    }
}
