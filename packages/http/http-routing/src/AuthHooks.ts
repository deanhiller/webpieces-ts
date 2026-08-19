import { JwtRequirement, rolesRequired, HttpForbiddenError } from '@webpieces/core-util';
import { HttpRequest, RawRequest } from '@webpieces/core-context';
import { AuthValues } from './AuthConfig';

/**
 * JwtHook - the OPTIONAL user-JWT mechanism. Its DI token is the {@link JWT_HOOK} Symbol injected via
 * `@inject(JWT_HOOK)` (a Symbol, because the app container uses autobind; rebindable in tests). Bind one
 * to turn on `@AuthJwt({...})` endpoints. When NO JwtHook is bound, the framework
 * {@link AuthFilter} treats every jwt endpoint as "not enabled" and fails fast (401) — there is no
 * default JWT verification because it needs an app secret + payload shape the framework can't guess.
 *
 *  - `parseJwt`     — AUTHENTICATION: decode/verify a user JWT into {@link AuthValues}, or throw. The
 *                     app owns the strategy (HS256 secret, RS256 + JWKS, a provider SDK, ...).
 *  - `authorizeJwt` — AUTHORIZATION: check the authenticated user against the endpoint's
 *                     {@link JwtRequirement}. The DEFAULT enforces the roles any-of; override for
 *                     app-defined requirements carried by the SAME decorator, e.g.
 *                     `@AuthJwt({allRolesAllowed: true, inOrg: true})` →
 *                     `if (requirement['inOrg'] && !values.claims['orgId']) ...`.
 *
 * BOTH ARE ASYNC, and both for the same reason: the strategy is the app's, and an app's strategy
 * reaches the network. `parseJwt` may fetch a JWKS or call a provider SDK; `authorizeJwt`'s own
 * motivating example — `@AuthJwt({allRolesAllowed: true, inOrg: true})` — is a membership question a
 * real app answers from a datastore. A sync signature makes both of those unwritable, and it made
 * `JwtHook` the last sync hook: {@link OidcHook.verifyOidc}, {@link WebhookAuthCallback.verify} and
 * {@link ApiKeyHook.verifyApiKey} all return promises. An implementation that needs no I/O simply has
 * no `await` in its body — {@link DefaultJwtHook} is exactly that and pays nothing for it.
 */
export abstract class JwtHook {
    /**
     * Parse a user JWT (kind:'jwt') — AUTHENTICATION only. Return who the user is, or throw.
     * ASYNC so an app can reach a JWKS endpoint or a provider SDK; see the class doc.
     */
    abstract parseJwt(token: string): Promise<AuthValues>;

    /**
     * DEFAULT authorization: enforce the endpoint's roles (any-of). Override to enforce app-defined
     * requirements. Throw HttpForbiddenError to deny; return to allow. ASYNC so an app-defined
     * requirement can be answered from a datastore; see the class doc.
     */
    async authorizeJwt(values: AuthValues, requirement: JwtRequirement): Promise<void> {
        // rolesRequired is the ONE reader of the JwtRoles union: [] means the endpoint typed
        // `allRolesAllowed: true`, never "the field was missing" — that state no longer compiles.
        const roles = rolesRequired(requirement);
        if (roles.length > 0 && !roles.some((role: string) => values.roles.includes(role))) {
            throw new HttpForbiddenError(`Endpoint requires one of roles: ${roles.join(', ')}`);
        }
    }
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
 * directly, so a server that wires nothing still verifies Google OIDC against its `@AuthOidc(...callers)`
 * (else trusts the edge — any Google-signed caller). `verifyOidc` verifies the token against `callers`;
 * throw on failure.
 */
export abstract class OidcHook {
    abstract verifyOidc(token: string, callers: string[]): Promise<void>;
}

/**
 * DI identifier for the optional {@link OidcHook} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(OIDC_HOOK)`
 * correct — undefined when unbound. The OidcHook class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const OIDC_HOOK = Symbol.for('OidcHook');

/**
 * WebhookAuthCallback - the OPTIONAL mechanism behind `@AuthWebhook(name)`: prove that an inbound request was
 * really authored by the outside vendor the contract names. Its DI token is the {@link WEBHOOK_AUTH_CALLBACK}
 * Symbol injected via `@inject(WEBHOOK_AUTH_CALLBACK)` (a Symbol, because the app container uses autobind;
 * rebindable in tests). The third hook, symmetric with {@link JwtHook} / {@link OidcHook}:
 *
 * ```typescript
 * // AppModule.ts, beside the CompanyJwtHook binding
 * options.bind(WEBHOOK_AUTH_CALLBACK).to(CompanyWebhookAuthCallback);
 * ```
 *
 * When NO WebhookAuthCallback is bound, the framework {@link AuthFilter} 401s every `@AuthWebhook` endpoint,
 * exactly as it does for an unbound JwtHook. There is no framework default and there never will be
 * one: silently allowing an unverified webhook is the single default that must not exist, and the
 * framework ships no vendor crypto by design (see {@link AuthWebhook} for why reimplementing five
 * vendors' schemes is a losing trade).
 *
 * ONE hook serves EVERY vendor: `name` selects which, so an app with a Sentry hook and a Twilio hook
 * switches on it rather than binding a token per vendor. What arrives is enough of the raw request to
 * call the vendor's OWN validator — the bytes for a body-signing vendor (Sentry, GitHub, Stripe,
 * Slack), the absolute url for one that signs the url instead (Twilio).
 */
export abstract class WebhookAuthCallback {
    /**
     * Verify ONE inbound request. Return to allow; throw {@link HttpUnauthorizedError} to deny.
     *
     * @param name   the string on the contract's `@AuthWebhook(name)` — which vendor this route is.
     * @param request the transport-neutral request (method, path, headers).
     * @param raw    the verbatim bytes + absolute url, guaranteed present: `@AuthWebhook` requires
     *               `@Endpoint(..., { rawBody: true })` at wiring time, and AuthFilter 401s rather
     *               than calling this hook with nothing to check.
     */
    abstract verify(name: string, request: HttpRequest, raw: RawRequest): Promise<void>;
}

/**
 * DI identifier for the optional {@link WebhookAuthCallback} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(WEBHOOK_AUTH_CALLBACK)`
 * correct — undefined when unbound. The WebhookAuthCallback class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const WEBHOOK_AUTH_CALLBACK = Symbol.for('WebhookAuthCallback');

/**
 * HeaderReader - read-only access to the inbound request's headers, and the ONLY thing an
 * {@link ApiKeyHook} is handed besides the regime name.
 *
 * It is an INTERFACE, not a class, because it is behaviour rather than data (per the guidelines) —
 * and it is NARROWER than {@link HttpRequest} on purpose. An api-key hook's job is to read the
 * credential headers and look them up; giving it the whole request would also give it the retained
 * raw bytes and the parsed body, none of which it has any business deciding authentication on.
 * `HttpRequest` satisfies this structurally, so the framework passes the live request and a spec can
 * pass a two-line stub.
 */
export interface HeaderReader {
    /** First value of the header, by lowercased name, or undefined when absent. */
    getHeader(name: string): string | undefined;
}

/**
 * ApiKeyHook - the OPTIONAL mechanism behind `@AuthApiKey(name)`: authenticate a CUSTOMER-held api key
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
 * When NO ApiKeyHook is bound, the framework {@link AuthFilter} 401s every `@AuthApiKey` endpoint,
 * exactly as it does for an unbound JwtHook. There is no framework default and there never will be
 * one: the key regime lives in the app's datastore, under the app's hashing scheme, behind the app's
 * choice of header names.
 *
 * THE ONE THING THIS HAS THAT `JwtHook.parseJwt` DOES NOT: it receives a {@link HeaderReader}, not one
 * pre-extracted token. A real key regime validates the key TOGETHER WITH a second header — the
 * organization the caller is acting for — and a hook handed one header's value physically cannot do
 * that cross-check. The framework therefore configures no api-key header name: which headers carry the
 * credential is the app's business. (Being ASYNC is no longer a difference — every hook here is, and
 * for the same reason: an app's strategy reaches the network.)
 *
 * ONE hook serves EVERY regime: `name` selects which, so a server with a partner-api regime and an
 * internal-tooling regime switches on it rather than binding a token per regime.
 */
export abstract class ApiKeyHook {
    /**
     * AUTHENTICATE one inbound request. Return who the caller is plus the {@link AuthValues.entries}
     * the framework seeds into `RequestContext` via `putTrusted`, or throw
     * {@link HttpUnauthorizedError} to deny.
     *
     * NOTE the seeded entries are TRUSTED context keys, so return only what THIS hook proved from the
     * credential it just verified. Anything the caller merely asserted on the wire is not admitted by
     * `@AuthApiKey` — the mode is deliberately caller-NOT-verified (see `AuthFilter.verifiesCaller`),
     * because a customer is not an internal service.
     *
     * @param name    the string on the contract's `@AuthApiKey(name)` — which key regime this route is.
     * @param headers the inbound request's headers; read as many as the regime needs.
     */
    abstract verifyApiKey(name: string, headers: HeaderReader): Promise<AuthValues>;
}

/**
 * DI identifier for the optional {@link ApiKeyHook} binding. It is a Symbol (not the class) so the app
 * container's inversify autobind never auto-constructs this token, keeping `@optional() @inject(API_KEY_HOOK)`
 * correct — undefined when unbound. The ApiKeyHook class stays the TYPE and the impl base.
 */
// webpieces-disable no-symbol-di-tokens -- optional DI token: must be a Symbol so the app container's autobind never auto-constructs this token, keeping @optional() @inject(...) correct (undefined when unbound)
export const API_KEY_HOOK = Symbol.for('ApiKeyHook');
