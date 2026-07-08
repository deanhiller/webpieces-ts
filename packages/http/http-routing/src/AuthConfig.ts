/**
 * Principal - the authenticated caller established by {@link AuthConfig.verifyJwt}.
 * Data-only structure (a class, per the webpieces guidelines).
 */
export class Principal {
    constructor(
        public readonly userId: string,
        // webpieces-disable no-any-unknown -- JWT claims are an arbitrary provider-defined bag
        public readonly claims: Record<string, unknown> = {},
    ) {}
}

/**
 * AuthConfig - the app-provided verifiers the framework {@link AuthFilter} injects to enforce
 * each endpoint's AuthMode. It is an ABSTRACT CLASS (not a Symbol) so it is injected by type
 * (per the webpieces no-symbol-di-tokens guidance) and rebindable in tests.
 *
 * It is BOUND IN THE APP CONTAINER (appBindings) — remember the two containers: the framework
 * AuthFilter is resolved from the app child container, so the app's binding (or a test's
 * appOverrides rebind) is what it sees. Keeping the concrete verifiers here (not in http-routing)
 * means http-routing needs NO crypto / gcp-identity — it stays transport- and provider-neutral.
 *
 * A public-only server need not bind one (AuthFilter injects it @optional); a non-public route
 * with no AuthConfig bound fails fast.
 */
export abstract class AuthConfig {
    /** Verify a user JWT (kind:'jwt'); return the principal or throw HttpUnauthorizedError. */
    abstract verifyJwt(token: string): Principal;

    /** Verify a Google OIDC token from an allowed caller SA (kind:'oidc'); throw on failure. */
    abstract verifyOidc(token: string, callers: string[]): Promise<void>;

    /** The expected shared secret for the given env var name (kind:'shared-secret'). */
    abstract sharedSecret(secretEnv: string): string | undefined;
}
