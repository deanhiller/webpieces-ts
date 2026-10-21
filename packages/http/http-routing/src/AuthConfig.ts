import { ContextKey } from '@webpieces/core-util';
import { AuthenticatedCaller } from '@webpieces/core-context';

// Defined in @webpieces/core-context (beside HttpRequest, which http-routing re-exports the same way)
// so VendorAuthVerifier (defined there beside its outbound twin VendorAuthMinter) can name it from a
// package both the node client and this router depend on.
export { AuthenticatedCaller, AuthenticatedMachineIdentity } from '@webpieces/core-context';

/**
 * SharedSecrets - the accepted values for ONE `sharedSecret(name)`. BOTH secret1 AND secret2
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
    'resolved by the framework AuthFilter from a credential an app-bound JwtHook, ApiKeyHook or VendorAuthVerifier verified',
    /*httpHeader*/ undefined,
    /*maskInLogs*/ false,
    /*isLogged*/ false,
);

/**
 * AuthConfig - the app-provided SHARED-SECRET state the framework {@link AuthFilter} reads to
 * enforce `sharedSecret(name)` endpoints. It holds ONLY the accepted secret values (STATE) —
 * there is no verification code here. The verification MECHANISMS are separate optional hooks the
 * app binds when it needs them:
 *
 *  - user JWT  → bind a {@link JwtHook} (async parseJwt).
 *  - api key   → bind an {@link ApiKeyHook} (async verifyApiKey over the request's headers).
 *  - OIDC      → bind an {@link OidcHook} to override the framework's default verifier; a server that
 *                binds nothing still verifies Google OIDC via the built-in {@link DefaultOidcVerifier}.
 *
 * So a zero-wiring server accepts service-to-service OIDC out of the box, and an app only binds the
 * pieces it actually uses. This class is injected `@optional` into AuthFilter (rebindable in tests);
 * a server SERVING a `sharedSecret(key)` endpoint with no AuthConfig, or one not holding `key`, refuses
 * to boot (#1362, `AuthFilter.assertRouteVerifiable`).
 */
export class AuthConfig {
    /** Accepted shared-secret values keyed by `sharedSecret(name)`. DEFAULT empty — pass to enable. */
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
