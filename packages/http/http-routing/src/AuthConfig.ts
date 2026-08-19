import { ContextKey, ContextTuple } from '@webpieces/core-util';

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
 * AuthenticatedCaller - what an authenticator PROVED about the caller of ONE request. Every hook
 * that authenticates resolves to this: {@link JwtHook.parseJwt}, {@link ApiKeyHook.verifyApiKey} and
 * {@link WebhookAuthCallback.verifyWebhook}. Four fields, three jobs:
 *
 *  - `userId`          — WHO the caller is, as the credential proved it.
 *  - `roles` / `claims` — the AUTHORIZATION inputs: `roles` is what the framework's own any-of check
 *                        reads, `claims` is the raw payload an app's {@link JwtHook.authorizeJwt}
 *                        override reads for app-defined requirements (inOrg, tenant, ...).
 *  - `entries`         — the TRUSTED CONTEXT to seed. The framework writes each one with
 *                        {@link RequestContext.putTrusted}, so return only what THIS authenticator
 *                        derived from the credential it just verified.
 *
 * NAMING, said out loud so it is not "fixed" back: it is deliberately NOT a `TrustedContextMap`.
 * Three of the four fields are not context, and it is not a Map — it is the authenticated caller,
 * and the context is one thing it carries.
 *
 * Data-only structure (a class, per the guidelines).
 */
export class AuthenticatedCaller {
    constructor(
        public readonly userId: string,
        public readonly roles: string[] = [],
        public readonly entries: ContextTuple[] = [],
        // webpieces-disable no-any-unknown -- raw JWT claims for app-defined authorization (inOrg, tenant, ...)
        public readonly claims: Record<string, unknown> = {},
    ) {}
}

/**
 * The context slot holding the {@link AuthenticatedCaller} the framework {@link AuthFilter} resolved
 * for this request. A real TRUSTED {@link ContextKey}, written with `RequestContext.putTrusted` and
 * read with `RequestContext.getTrusted` — it replaces a raw `'__webpieces_principal__'` string that
 * was the one place in the codebase bypassing the typed context layer.
 *
 * `httpHeader` is deliberately UNDEFINED, so the key is context-only and NEVER travels. Two reasons,
 * and either alone is decisive: the value is an OBJECT, which no HTTP header can carry; and a
 * principal is proof THIS hop's authenticator produced, so forwarding it would hand the next service
 * a "proven" caller nothing on that hop verified. The individual facts a downstream service needs
 * (userId, orgId, roles) already propagate as their own transferred keys in
 * {@link WebpiecesCoreHeaders}, gated by the caller-verified rule.
 *
 * `isLogged` is FALSE: it is an object carrying the raw credential claims, which has no business
 * being serialized into a log line.
 */
export const AUTHENTICATED_CALLER_KEY = ContextKey.trusted<AuthenticatedCaller>(
    'authenticatedCaller',
    'resolved by the framework AuthFilter from a credential an app-bound JwtHook, ApiKeyHook or WebhookAuthCallback verified',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ false,
);

/**
 * AuthConfig - the app-provided SHARED-SECRET state the framework {@link AuthFilter} reads to
 * enforce `@AuthSharedSecret(name)` endpoints. It holds ONLY the accepted secret values (STATE) —
 * there is no verification code here. The verification MECHANISMS are separate optional hooks the
 * app binds when it needs them:
 *
 *  - user JWT  → bind a {@link JwtHook} (async parseJwt + async authorizeJwt).
 *  - api key   → bind an {@link ApiKeyHook} (async verifyApiKey over the request's headers).
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
