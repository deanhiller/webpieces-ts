import { ContextTuple } from '@webpieces/core-util';

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
 * AuthValues - what {@link JwtHook.parseJwt} returns: the authenticated user's id + roles (used
 * by the framework to stamp a principal and enforce @AuthJwt(...roles)) plus any extra context
 * entries the app wants set (orgId, tenant, ...). The framework sets `entries` into RequestContext
 * via {@link RequestContext.putHeader}. Data-only structure (a class, per the guidelines).
 */
export class AuthValues {
    constructor(
        public readonly userId: string,
        public readonly roles: string[] = [],
        public readonly entries: ContextTuple[] = [],
        // webpieces-disable no-any-unknown -- raw JWT claims for app-defined authorization (inOrg, tenant, ...)
        public readonly claims: Record<string, unknown> = {},
    ) {}
}

/**
 * AuthConfig - the app-provided SHARED-SECRET state the framework {@link AuthFilter} reads to
 * enforce `@AuthSharedSecret(name)` endpoints. It holds ONLY the accepted secret values (STATE) —
 * there is no verification code here. The verification MECHANISMS are separate optional hooks the
 * app binds when it needs them:
 *
 *  - user JWT  → bind a {@link JwtHook} (parseJwt + authorizeJwt).
 *  - OIDC      → bind an {@link OidcHook} to override the framework's default verifier; a server that
 *                binds nothing still verifies Google OIDC via the built-in {@link DefaultOidcVerifier}.
 *
 * So a zero-wiring server accepts service-to-service OIDC out of the box, and an app only binds the
 * pieces it actually uses. This class is injected `@optional` into AuthFilter (rebindable in tests);
 * when unbound, shared-secret endpoints simply have no accepted secret and fail fast (401).
 */
export class AuthConfig {
    /** Accepted shared-secret values keyed by `@AuthSharedSecret(name)`. DEFAULT empty — pass to enable. */
    readonly sharedSecrets: Record<string, SharedSecrets>;

    constructor(sharedSecrets: Record<string, SharedSecrets> = {}) {
        this.sharedSecrets = sharedSecrets;
    }
}

/**
 * DI identifier for the optional {@link AuthConfig} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(AUTH_CONFIG)`
 * correct — undefined when unbound. The AuthConfig class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const AUTH_CONFIG = Symbol.for('AuthConfig');
