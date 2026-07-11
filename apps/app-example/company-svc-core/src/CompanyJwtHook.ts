import { injectable } from 'inversify';
import jwt from 'jsonwebtoken';
import { JwtHook, AuthValues } from '@webpieces/http-routing';
import { ContextTuple, HttpUnauthorizedError, HttpForbiddenError, JwtRequirement, toError, WebpiecesCoreHeaders } from '@webpieces/core-util';

/**
 * CompanyJwtHook - the company's user-JWT mechanism, bound to the framework {@link JwtHook} so every
 * company service inherits working @AuthJwt / @Auth auth. Written ONCE at the company layer:
 *
 *  - parseJwt: verify a user JWT with `jsonwebtoken` (secret from JWT_SECRET) → userId(`sub`) +
 *    roles(`roles` claim) + the USER_ID context entry. Minting a JWT is a login-controller concern.
 *  - authorizeJwt: default roles any-of (via super) PLUS the company rule that @Auth({ inOrg: true })
 *    requires an orgId claim.
 *
 * OIDC is NOT wired here — the framework {@link DefaultOidcVerifier} handles service-to-service OIDC
 * by default, so a company service gets it for free. Shared secrets live on {@link CompanyAuthConfig}.
 */
@injectable()
export class CompanyJwtHook extends JwtHook {
    private readonly jwtSecret = process.env['JWT_SECRET'] ?? 'dev-insecure-jwt-secret-change-me';

    override parseJwt(token: string): AuthValues {
        const claims = this.decode(token);
        const subject = claims['sub'] ?? claims['userId'];
        if (subject === undefined || subject === null || subject === '') {
            throw new HttpUnauthorizedError('JWT has no subject (sub/userId) claim');
        }
        const userId = String(subject);
        const roles = Array.isArray(claims['roles']) ? claims['roles'].map(String) : [];
        return new AuthValues(userId, roles, [new ContextTuple(WebpiecesCoreHeaders.USER_ID, userId)], claims);
    }

    /**
     * AUTHORIZATION: the company policy over the endpoint's @Auth/@AuthJwt requirement. Default
     * roles any-of (via super), PLUS this company's custom rule: @Auth({ inOrg: true }) requires the
     * JWT to carry an orgId claim. This is the pluggable seam — apps enforce their own rules here
     * without touching the framework.
     */
    override authorizeJwt(values: AuthValues, requirement: JwtRequirement): void {
        super.authorizeJwt(values, requirement); // roles any-of
        if (requirement['inOrg'] === true && !values.claims['orgId']) {
            throw new HttpForbiddenError('Endpoint requires an organization (orgId claim) on the JWT');
        }
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
