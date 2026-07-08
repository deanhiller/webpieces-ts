import { ContextKey } from '@webpieces/core-util';

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
    /** Expected shared-secret values keyed by the `@AuthSharedSecret(name)` name. STATE. */
    abstract readonly sharedSecrets: Record<string, string>;

    /** Parse a user JWT (kind:'jwt'); return the auth values or throw HttpUnauthorizedError. */
    abstract parseJwt(token: string): AuthValues;

    /** Verify a Google OIDC token from an allowed caller (kind:'oidc'); throw on failure. */
    abstract verifyOidc(token: string, callers: string[]): Promise<void>;
}
