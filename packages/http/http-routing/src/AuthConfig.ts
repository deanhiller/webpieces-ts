import { ContextKey, JwtRequirement, HttpForbiddenError } from '@webpieces/core-util';

/**
 * ContextValue - one (ContextKey, value) pair the JWT parse plugin wants stamped into the
 * RequestContext (e.g. USER_ID, ORG_ID). Data-only structure (a class, per the guidelines).
 */
export class ContextValue {
    constructor(
        public readonly key: ContextKey,
        // webpieces-disable no-any-unknown -- context values are arbitrary app-defined data
        public readonly value: unknown,
    ) {}
}

/**
 * SharedSecrets - the accepted values for ONE `@AuthSharedSecret(name)`. BOTH secret1 AND secret2
 * are accepted — this is what makes zero-downtime ROTATION possible:
 *
 *   to rotate: shift secret2 → secret1, and put the NEW secret in secret2. Callers cut over from
 *   the old value to the new during the window; once every caller sends the new one, the stale
 *   value falls out on the next shift. At all times EITHER key works, so no request is dropped.
 *
 * Data-only structure (a class, per the guidelines). Leave secret2 empty for a single secret.
 */
export class SharedSecrets {
    constructor(
        public readonly secret1: string,
        public readonly secret2: string,
    ) {}
}

/**
 * AuthValues - what {@link AuthConfig.parseJwt} returns: the authenticated user's id + roles (used
 * by the framework to stamp a principal and enforce @AuthJwt(...roles)) plus any extra context
 * entries the app wants set (orgId, tenant, ...). The framework sets `entries` into RequestContext
 * via {@link RequestContext.putHeader}. Data-only structure (a class, per the guidelines).
 */
export class AuthValues {
    constructor(
        public readonly userId: string,
        public readonly roles: string[] = [],
        public readonly entries: ContextValue[] = [],
        // webpieces-disable no-any-unknown -- raw JWT claims for app-defined authorization (inOrg, tenant, ...)
        public readonly claims: Record<string, unknown> = {},
    ) {}
}

/**
 * AuthConfig - the ONE app-provided auth binding the framework {@link AuthFilter} injects to enforce
 * each endpoint's AuthMode. It is a single abstract class (injected by type, per no-symbol-di-tokens)
 * bound in the APP container and rebindable in tests. Each mechanism has its RIGHT shape:
 *
 *  - `sharedSecrets`  — STATE: the expected secret VALUE per name (from `@AuthSharedSecret(name)`).
 *                       Prod fills it from env; a test binds `{ NAME: 'some-test-key' }` and can then
 *                       exercise the shared-secret path (and a negative test with a wrong key).
 *  - `parseJwt`       — PLUGIN: decode/verify a user JWT into {@link AuthValues} (userId, roles,
 *                       context entries). Minting a JWT is a controller concern (login), not here.
 *  - `verifyOidc`     — PLUGIN: verify a Google OIDC service-to-service token against the endpoint's
 *                       caller allow-list. Fully generic — the company base wires it to
 *                       @webpieces/gcp-identity once, so apps never customize OIDC.
 *
 * Keeping the plugins app-side means http-routing needs NO jsonwebtoken / gcp-identity. AuthFilter
 * injects this `@optional`: a public-only server binds none; a non-public route with no AuthConfig
 * (or no value/plugin for its mode) fails fast.
 */
export abstract class AuthConfig {
    /**
     * Accepted shared-secret values keyed by the `@AuthSharedSecret(name)` name. STATE. Each entry
     * is a {@link SharedSecrets} (secret1 + secret2, either accepted) so secrets can be ROTATED
     * with zero dropped requests.
     */
    abstract readonly sharedSecrets: Record<string, SharedSecrets>;

    /** Parse a user JWT (kind:'jwt') — AUTHENTICATION only. Return who the user is, or throw. */
    abstract parseJwt(token: string): AuthValues;

    /** Verify a Google OIDC token from an allowed caller (kind:'oidc'); throw on failure. */
    abstract verifyOidc(token: string, callers: string[]): Promise<void>;

    /**
     * AUTHORIZATION: check the authenticated user against the endpoint's {@link JwtRequirement}.
     * DEFAULT enforces `roles` (any-of; empty = any authenticated user). OVERRIDE to enforce
     * app-defined requirements carried by `@Auth({...})` — e.g.
     * `if (requirement['inOrg'] && !values.claims['orgId']) throw new HttpForbiddenError(...)`.
     * Throw HttpForbiddenError to deny; return to allow. This is the pluggable seam.
     */
    authorizeJwt(values: AuthValues, requirement: JwtRequirement): void {
        const roles = requirement.roles ?? [];
        if (roles.length > 0 && !roles.some((role: string) => values.roles.includes(role))) {
            throw new HttpForbiddenError(`Endpoint requires one of roles: ${roles.join(', ')}`);
        }
    }
}
