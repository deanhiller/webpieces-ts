import { randomUUID } from 'node:crypto';
import { sign, verify, JwtPayload } from 'jsonwebtoken';
import { ApiUnauthorizedError, toError } from '@webpieces/core-util';
import { JwtHook, MintedJwt } from './AuthHooks';
import { AuthenticatedCaller } from './AuthConfig';

/** Mint input for the optional batteries-included HS256 authority. Custom authorities own their input type. */
export class DefaultJwtMintRequest {
    constructor(
        public readonly subject: string,
        public readonly roles: readonly string[],
        public readonly expiresInSeconds: number,
        public readonly claims: Readonly<JwtPayload>,
    ) {}
}

/**
 * DefaultJwtHook - a batteries-included {@link JwtHook} for the common case: HS256 user JWTs signed
 * with ONE shared secret. Construct it with the secret and bind it — `new DefaultJwtHook(secret)` —
 * and `@WpAuthJwt` endpoints work with NO custom verification code.
 *
 * `parseJwt` verifies the signature + expiry (jsonwebtoken, HS256 only) and maps standard claims:
 * `sub` → userId, a string[] `roles` claim → roles, the whole payload → claims. `authorizeJwt`
 * (role enforcement) is inherited from JwtHook. For RS256 + JWKS, a provider SDK, or a non-standard
 * payload, write your own JwtHook subclass instead.
 *
 * It satisfies {@link JwtHook}'s ASYNC signature with a body that awaits NOTHING, and that is the
 * point rather than an oversight: HS256 against a local secret is pure CPU. The signature is async
 * because the hook is the APP's seam and an app's strategy reaches the network — not because this
 * implementation does. No fake await is added to justify it.
 */
export class DefaultJwtHook extends JwtHook<DefaultJwtMintRequest> {
    private readonly secret: string;

    constructor(secret: string) {
        super();
        this.secret = secret;
    }

    override async mint(request: DefaultJwtMintRequest): Promise<MintedJwt> {
        if (request.expiresInSeconds <= 0) {
            throw new Error('JWT lifetime must be greater than zero seconds.');
        }
        // webpieces-disable no-anonymous-object-literals -- jsonwebtoken payload is an external claim bag
        const payload = { ...request.claims, roles: request.roles };
        const token = sign(payload, this.secret, {
            algorithm: 'HS256',
            subject: request.subject,
            expiresIn: request.expiresInSeconds,
            jwtid: randomUUID(),
        });
        return new MintedJwt(token, Math.floor(Date.now() / 1000) + request.expiresInSeconds);
    }

    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        const payload = this.verifyToken(token);
        const userId = payload.sub;
        if (!userId) {
            throw new ApiUnauthorizedError('JWT is missing the required "sub" (subject) claim');
        }
        return new AuthenticatedCaller(userId, this.extractRoles(payload), [], payload);
    }

    /** Verify HS256 signature + expiry; translate jsonwebtoken's raw error into a framework 401. */
    private verifyToken(token: string): JwtPayload {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- AUTH TRANSLATION CHOKEPOINT: jsonwebtoken.verify throws on a bad/expired token; that must surface as a 401 Unauthorized, not bubble to the global handler as a 500. The original error is chained via cause.
        try {
            const decoded = verify(token, this.secret, { algorithms: ['HS256'] });
            if (typeof decoded === 'string') {
                throw new ApiUnauthorizedError('JWT payload must be a JSON object, not a string');
            }
            return decoded;
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof ApiUnauthorizedError) {
                throw error;
            }
            throw new ApiUnauthorizedError('JWT verification failed', undefined, error);
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
