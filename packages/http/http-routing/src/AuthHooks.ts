import { HttpRequest, RawHttpRequest } from '@webpieces/core-context';
import { AuthenticatedCaller, AuthenticatedMachineIdentity } from './AuthConfig';

/** Framework-normalized result from an application-owned JWT mint operation. */
export class MintedJwt {
    constructor(
        public readonly token: string,
        public readonly expiresAtEpochSeconds: number,
    ) {
        if (token.trim() === '') throw new Error('Minted JWT token must be non-empty.');
        if (!Number.isFinite(expiresAtEpochSeconds)) {
            throw new Error('Minted JWT expiry must be a finite epoch-second value.');
        }
    }
}

/** Optional application JWT credential authority. Authorization lives in AuthorizationHook. */
export abstract class JwtHook<TMintRequest> {
    abstract mint(request: TMintRequest): Promise<MintedJwt>;
    abstract parseJwt(token: string): Promise<AuthenticatedCaller>;
}

/**
 * DI identifier for the optional {@link JwtHook} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(JWT_HOOK)`
 * correct — undefined when unbound. The JwtHook class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const JWT_HOOK = Symbol.for('JwtHook');

/**
 * OidcHook - the OPTIONAL override for Google OIDC service-to-service verification. Its DI token is the
 * {@link OIDC_HOOK} Symbol injected via `@inject(OIDC_HOOK)` (a Symbol, because the app container uses
 * autobind; rebindable in tests). Bind one ONLY to customize the caller policy — e.g. an app that reads an
 * `ALLOWED_OIDC_CALLERS` env var at its composition root and enforces that allow-list. When NO
 * OidcHook is bound, the framework {@link AuthFilter} runs the built-in {@link DefaultOidcVerifier}
 * directly, so a server that wires nothing still verifies Google OIDC against its `@WpAuthOidc(...callers)`
 * (else trusts the edge — any Google-signed caller). `verifyOidc` verifies the token against `callers`;
 * throw on failure.
 */
export abstract class OidcHook {
    abstract verifyOidc(token: string, callers: string[]): Promise<AuthenticatedMachineIdentity>;
}

/**
 * DI identifier for the optional {@link OidcHook} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(OIDC_HOOK)`
 * correct — undefined when unbound. The OidcHook class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const OIDC_HOOK = Symbol.for('OidcHook');

/**
 * WebhookAuthCallback - the OPTIONAL mechanism behind `@WpAuthWebhook(name)`: prove that an inbound request was
 * really authored by the outside vendor the contract names. Its DI token is the {@link WEBHOOK_AUTH_CALLBACK}
 * Symbol injected via `@inject(WEBHOOK_AUTH_CALLBACK)` (a Symbol, because the app container uses autobind;
 * rebindable in tests). The third hook, symmetric with {@link JwtHook} / {@link OidcHook}:
 *
 * ```typescript
 * // AppModule.ts, beside the CompanyJwtHook binding
 * options.bind(WEBHOOK_AUTH_CALLBACK).to(CompanyWebhookAuthCallback);
 * ```
 *
 * When NO WebhookAuthCallback is bound, the framework {@link AuthFilter} 401s every `@WpAuthWebhook` endpoint,
 * exactly as it does for an unbound JwtHook. There is no framework default and there never will be
 * one: silently allowing an unverified webhook is the single default that must not exist, and the
 * framework ships no vendor crypto by design (see {@link WpAuthWebhook} for why reimplementing five
 * vendors' schemes is a losing trade).
 *
 * ONE hook serves EVERY vendor: `name` selects which, so an app with a Sentry hook and a Twilio hook
 * switches on it rather than binding a token per vendor. What arrives is enough of the raw request to
 * call the vendor's OWN validator — `request.raw.rawBody` for a body-signing vendor (Sentry, GitHub,
 * Stripe, Slack), `request.raw.absoluteUrl` for one that signs the url instead (Twilio).
 */
export abstract class WebhookAuthCallback {
    /**
     * Verify ONE inbound request. Return the {@link AuthenticatedCaller} the vendor's signature
     * proved; throw {@link ApiUnauthorizedError} to deny.
     *
     * IT RETURNS A CALLER, not `void`, for the same reason {@link ApiKeyHook.verifyApiKey} does: once
     * the signature checks out, the payload's vendor account is a PROVEN fact, and a hook that could
     * only return `void` had no way to say so. The framework seeds `entries` with
     * `RequestContext.putTrusted` exactly as it does for a jwt or api-key caller, so a controller
     * reads which vendor account this webhook is for off the context instead of re-deriving it.
     *
     * Return only what THIS hook proved from the signature it just verified. `webhook` remains
     * caller-NOT-verified (see `AuthFilter.verifiesCaller`): a vendor is not a peer service, so
     * nothing the vendor merely ASSERTED on the wire is admitted.
     *
     * @param name    the string on the contract's `@WpAuthWebhook(name)` — which vendor this route is.
     * @param request the transport-neutral request, narrowed to {@link RawHttpRequest}: `request.raw`
     *                holds the verbatim bytes + absolute url and is PRESENT, never optional.
     *                `@WpAuthWebhook` requires `@Endpoint(..., { rawBody: true })` at wiring time, and
     *                AuthFilter 401s rather than calling this hook with nothing to check — so an
     *                implementation never writes `raw!` or a guard of its own.
     */
    abstract verifyWebhook(name: string, request: RawHttpRequest): Promise<AuthenticatedCaller>;
}

/**
 * DI identifier for the optional {@link WebhookAuthCallback} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(WEBHOOK_AUTH_CALLBACK)`
 * correct — undefined when unbound. The WebhookAuthCallback class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const WEBHOOK_AUTH_CALLBACK = Symbol.for('WebhookAuthCallback');

/**
 * ApiKeyHook - the OPTIONAL mechanism behind `@WpAuthApiKey(regime, credentials)`: authenticate a
 * CUSTOMER-held api key
 * against the app's own datastore and return the context to seed. Its DI token is the
 * {@link API_KEY_HOOK} Symbol injected via `@inject(API_KEY_HOOK)` (a Symbol, because the app container
 * uses autobind; rebindable in tests). The fourth hook, symmetric with {@link JwtHook} /
 * {@link OidcHook} / {@link WebhookAuthCallback}:
 *
 * ```typescript
 * // AppModule.ts, beside the CompanyJwtHook binding
 * options.bind(API_KEY_HOOK).to(OneTabletApiKeyHook);
 * ```
 *
 * When NO ApiKeyHook is bound, the framework {@link AuthFilter} 401s every `@WpAuthApiKey` endpoint,
 * exactly as it does for an unbound JwtHook. There is no framework default and there never will be
 * one: the key regime lives in the app's datastore, under the app's hashing scheme, behind the app's
 * choice of header names.
 *
 * THE ONE THING THIS HAS THAT `JwtHook.parseJwt` DOES NOT: it receives the whole {@link HttpRequest},
 * not one pre-extracted token. A real key regime validates the key TOGETHER WITH a second header — the
 * organization the caller is acting for — and a hook handed one header's value physically cannot do
 * that cross-check. The framework therefore EXTRACTS no api-key header: which headers carry the
 * credential is the app's business, and `getHeader` / `getHeaderValues` read as many as the regime
 * needs. The contract's `credentials` list DECLARES those header names for readers and spec
 * generators — it is documentation of the regime, never an instruction to this hook, so the hook
 * stays the single place the pair is actually validated. (Being ASYNC is no longer a difference — every hook here is, and for the same reason: an
 * app's strategy reaches the network.)
 *
 * ONE hook serves EVERY regime: `regime` selects which, so a server with a partner-api regime and an
 * internal-tooling regime switches on it rather than binding a token per regime.
 */
export abstract class ApiKeyHook {
    /**
     * AUTHENTICATE one inbound request. Return who the caller is plus the {@link AuthenticatedCaller.entries}
     * the framework seeds into `RequestContext` via `putTrusted`, or throw
     * {@link ApiUnauthorizedError} to deny.
     *
     * NOTE the seeded entries are TRUSTED context keys, so return only what THIS hook proved from the
     * credential it just verified. Anything the caller merely asserted on the wire is not admitted by
     * `@WpAuthApiKey` — the mode is deliberately caller-NOT-verified (see `AuthFilter.verifiesCaller`),
     * because a customer is not an internal service.
     *
     * @param regime  the first argument of the contract's `@WpAuthApiKey(regime, credentials)` — which key
     *                regime this route belongs to.
     * @param request the inbound request; read as many headers as the regime needs with
     *                `getHeader` / `getHeaderValues`, either by raw name or by {@link ContextKey}.
     */
    abstract verifyApiKey(regime: string, request: HttpRequest): Promise<AuthenticatedCaller>;
}

/**
 * DI identifier for the optional {@link ApiKeyHook} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(API_KEY_HOOK)`
 * correct — undefined when unbound. The ApiKeyHook class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const API_KEY_HOOK = Symbol.for('ApiKeyHook');
