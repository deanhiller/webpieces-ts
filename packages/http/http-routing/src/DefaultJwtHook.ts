import { verify, JwtPayload } from 'jsonwebtoken';
import { HttpUnauthorizedError, toError } from '@webpieces/core-util';
import { JwtHook } from './AuthHooks';
import { AuthValues } from './AuthConfig';

/**
 * DefaultJwtHook - a batteries-included {@link JwtHook} for the common case: HS256 user JWTs signed
 * with ONE shared secret. Construct it with the secret and bind it — `new DefaultJwtHook(secret)` —
 * and `@AuthJwt` endpoints work with NO custom verification code.
 *
 * `parseJwt` verifies the signature + expiry (jsonwebtoken, HS256 only) and maps standard claims:
 * `sub` → userId, a string[] `roles` claim → roles, the whole payload → claims. `authorizeJwt`
 * (role enforcement) is inherited from JwtHook. For RS256 + JWKS, a provider SDK, or a non-standard
 * payload, write your own JwtHook subclass instead.
 */
export class DefaultJwtHook extends JwtHook {
    private readonly secret: string;

    constructor(secret: string) {
        super();
        this.secret = secret;
    }

    override parseJwt(token: string): AuthValues {
        const payload = this.verifyToken(token);
        const userId = payload.sub;
        if (!userId) {
            throw new HttpUnauthorizedError('JWT is missing the required "sub" (subject) claim');
        }
        return new AuthValues(userId, this.extractRoles(payload), [], payload);
    }

    /** Verify HS256 signature + expiry; translate jsonwebtoken's raw error into a framework 401. */
    private verifyToken(token: string): JwtPayload {
        // webpieces-disable no-unmanaged-exceptions -- AUTH TRANSLATION CHOKEPOINT: jsonwebtoken.verify throws on a bad/expired token; that must surface as a 401 Unauthorized, not bubble to the global handler as a 500. The original error is chained via cause.
        try {
            const decoded = verify(token, this.secret, { algorithms: ['HS256'] });
            if (typeof decoded === 'string') {
                throw new HttpUnauthorizedError('JWT payload must be a JSON object, not a string');
            }
            return decoded;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof HttpUnauthorizedError) {
                throw error;
            }
            throw new HttpUnauthorizedError('JWT verification failed', undefined, error);
        }
    }

    private extractRoles(payload: JwtPayload): string[] {
        const roles = payload['roles'];
        if (Array.isArray(roles)) {
            return roles.filter((role: string) => typeof role === 'string');
        }
        return [];
    }
}
