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
 */
export abstract class JwtHook {
    /** Parse a user JWT (kind:'jwt') — AUTHENTICATION only. Return who the user is, or throw. */
    abstract parseJwt(token: string): AuthValues;

    /**
     * DEFAULT authorization: enforce the endpoint's roles (any-of). Override to enforce app-defined
     * requirements. Throw HttpForbiddenError to deny; return to allow.
     */
    authorizeJwt(values: AuthValues, requirement: JwtRequirement): void {
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
