import { injectable } from 'inversify';
import jwt from 'jsonwebtoken';
import { AuthConfig, AuthValues, ContextValue } from '@webpieces/http-routing';
import { HttpUnauthorizedError, toError } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { verifyOidcFromCallers } from '@webpieces/gcp-identity';

/**
 * CompanyAuthConfig - the ONE company auth binding, injected by the framework AuthFilter. Written
 * ONCE at the company layer so every company service inherits working auth:
 *
 *  - sharedSecrets: the expected secret VALUES, read from env by name (a test rebinds this class
 *    with fixed values). @AuthSharedSecret('X') → sharedSecrets['X'].
 *  - parseJwt: verify a user JWT with `jsonwebtoken` (secret from JWT_SECRET) → userId(`sub`) +
 *    roles(`roles` claim) + the USER_ID context entry. Minting a JWT is a login-controller concern.
 *  - verifyOidc: delegate to @webpieces/gcp-identity (fully generic — apps never customize OIDC).
 */
@injectable()
export class CompanyAuthConfig extends AuthConfig {
    private readonly jwtSecret = process.env['JWT_SECRET'] ?? 'dev-insecure-jwt-secret-change-me';

    // Prod reads the expected secret VALUES from env by the @AuthSharedSecret name. Tests rebind
    // this class (or bind a subclass) with fixed values.
    readonly sharedSecrets: Record<string, string> = {
        INTERNAL_API_SECRET: process.env['INTERNAL_API_SECRET'] ?? '',
    };

    override parseJwt(token: string): AuthValues {
        const claims = this.decode(token);
        const subject = claims['sub'] ?? claims['userId'];
        if (subject === undefined || subject === null || subject === '') {
            throw new HttpUnauthorizedError('JWT has no subject (sub/userId) claim');
        }
        const userId = String(subject);
        const roles = Array.isArray(claims['roles']) ? claims['roles'].map(String) : [];
        return new AuthValues(userId, roles, [new ContextValue(CompanyHeaders.USER_ID, userId)]);
    }

    override async verifyOidc(token: string, callers: string[]): Promise<void> {
        const result = await verifyOidcFromCallers(token, callers);
        if (!result.ok) {
            throw new HttpUnauthorizedError(`OIDC rejected: ${result.reason ?? 'not an allowed caller'}`);
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
