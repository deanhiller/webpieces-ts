import { JwtRequirement, HttpForbiddenError } from '@webpieces/core-util';
import { AuthValues } from './AuthConfig';

/**
 * JwtHook - the OPTIONAL user-JWT mechanism. Bind one (inject by type, per no-symbol-di-tokens;
 * rebindable in tests) to turn on `@AuthJwt(...)` endpoints. When NO JwtHook is bound, the framework
 * {@link AuthFilter} treats every jwt endpoint as "not enabled" and fails fast (401) — there is no
 * default JWT verification because it needs an app secret + payload shape the framework can't guess.
 *
 *  - `parseJwt`     — AUTHENTICATION: decode/verify a user JWT into {@link AuthValues}, or throw. The
 *                     app owns the strategy (HS256 secret, RS256 + JWKS, a provider SDK, ...).
 *  - `authorizeJwt` — AUTHORIZATION: check the authenticated user against the endpoint's
 *                     {@link JwtRequirement}. The DEFAULT enforces `roles` (any-of; empty = any
 *                     authenticated user); override for app-defined requirements carried by
 *                     `@Auth({...})` — e.g. `if (requirement['inOrg'] && !values.claims['orgId']) ...`.
 */
export abstract class JwtHook {
    /** Parse a user JWT (kind:'jwt') — AUTHENTICATION only. Return who the user is, or throw. */
    abstract parseJwt(token: string): AuthValues;

    /**
     * DEFAULT authorization: enforce `roles` (any-of; empty = any authenticated user). Override to
     * enforce app-defined requirements. Throw HttpForbiddenError to deny; return to allow.
     */
    authorizeJwt(values: AuthValues, requirement: JwtRequirement): void {
        const roles = requirement.roles ?? [];
        if (roles.length > 0 && !roles.some((role: string) => values.roles.includes(role))) {
            throw new HttpForbiddenError(`Endpoint requires one of roles: ${roles.join(', ')}`);
        }
    }
}

/**
 * OidcHook - the OPTIONAL override for Google OIDC service-to-service verification. Bind one (inject
 * by type; rebindable in tests) ONLY to customize the caller policy — e.g. an app that reads an
 * `ALLOWED_OIDC_CALLERS` env var at its composition root and enforces that allow-list. When NO
 * OidcHook is bound, the framework {@link AuthFilter} runs the built-in {@link DefaultOidcVerifier}
 * directly, so a server that wires nothing still verifies Google OIDC from its `@AuthOidc(...callers)`
 * (else `['self']`). `verifyOidc` verifies the token against `callers`; throw on failure.
 */
export abstract class OidcHook {
    abstract verifyOidc(token: string, callers: string[]): Promise<void>;
}
