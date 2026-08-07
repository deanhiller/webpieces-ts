import { inject, optional } from 'inversify';
import { timingSafeEqual } from 'crypto';
import { provideFrameworkSingleton, PendingWireTrust, PendingTrustedValue, RequestContext } from '@webpieces/core-context';
import { AuthMode, EndpointNotFoundError, HttpUnauthorizedError, JwtRequirement, LogManager, RuntimeLocality, toError } from '@webpieces/core-util';
import { Filter, WpResponse, Service } from '../Filter';
import { MethodMeta } from '../MethodMeta';
import { AuthConfig, AUTH_CONFIG, AuthValues, SharedSecrets } from '../AuthConfig';
import { JwtHook, JWT_HOOK, OidcHook, OIDC_HOOK } from '../AuthHooks';
import { DefaultOidcVerifier } from '../DefaultOidcVerifier';

const log = LogManager.getLogger('AuthFilter');

/**
 * The ONE credential header, read straight off the inbound HttpRequest.
 *
 * Deliberately NOT a ContextKey: a ContextKey with an httpHeader is a TRANSFERRED key, which would
 * put the caller's credential into RequestContext and hence onto every outbound call this service
 * makes, and onto every Cloud Task it enqueues. A credential belongs to ONE request hop.
 */
const AUTHORIZATION_HEADER = 'authorization';

/**
 * The scheme (first word of the Authorization value) names WHICH credential follows, so a secret
 * can never be mistaken for a token, nor accepted where the other was expected:
 *
 *   Authorization: Bearer <user JWT | service OIDC token>
 *   Authorization: Webpieces <@AuthSharedSecret value>
 *
 * The scheme is REQUIRED. A bare value with no scheme is rejected.
 */
const BEARER_SCHEME = 'Bearer';
const SHARED_SECRET_SCHEME = 'Webpieces';

/** Reserved context key holding the authenticated {@link AuthValues} (stamped after a jwt parse). */
const PRINCIPAL_KEY = '__webpieces_principal__';

/**
 * AuthFilter - the ONE framework auth filter, auto-installed just below the error filter on every
 * route. It is TRANSPORT-NEUTRAL: it reads the raw credential from the {@link HttpRequest} in
 * RequestContext (never express), so the SAME check runs over HTTP and via createApiClient.
 *
 * It enforces the endpoint's AuthMode from separately-bound pieces, each OPTIONAL except the OIDC
 * default:
 *  - shared-secret → constant-time compare vs the {@link AuthConfig} secret VALUE (state). No
 *                    AuthConfig bound → no accepted secret → fail fast (401).
 *  - jwt           → the bound {@link JwtHook} (`parseJwt` + `authorizeJwt`). No JwtHook bound →
 *                    "not enabled" (401): JWT needs an app secret + payload shape.
 *  - oidc          → the bound {@link OidcHook} if any, else the framework {@link DefaultOidcVerifier}
 *                    run DIRECTLY — so a server that wires NOTHING still verifies Google OIDC.
 *  - public        → BEST-EFFORT jwt parse (only if a JwtHook is bound): stamp the user's context so
 *                    a logged-out page still knows who is logged in; never fails.
 *  - local-only    → serve only when {@link RuntimeLocality} says this process is a developer's
 *                    machine; otherwise 404, indistinguishable from the route not existing (which,
 *                    off-local, it does not — `ApiRoutingFactory` never registered it).
 *
 * Zero wiring = OIDC just works; an app only binds the hooks it actually uses.
 */
@provideFrameworkSingleton()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
export class AuthFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    constructor(
        // Framework default, always available — verifies Google OIDC with zero app wiring.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- AuthFilter is DI-resolved via the esbuild/vitest path, which elides type-only imports (no design:paramtypes), so every param needs its explicit token
        @inject(DefaultOidcVerifier) private readonly oidcVerifier: DefaultOidcVerifier,
        // @optional: only bind an AuthConfig to enable @AuthSharedSecret endpoints.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(AUTH_CONFIG) private readonly authConfig?: AuthConfig,
        // @optional: only bind a JwtHook to enable @AuthJwt endpoints.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(JWT_HOOK) private readonly jwtHook?: JwtHook,
        // @optional: only bind an OidcHook to OVERRIDE the DefaultOidcVerifier caller policy.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(OIDC_HOOK) private readonly oidcHook?: OidcHook,
    ) {
        super();
    }

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
    override async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        const mode = meta.routeMeta.authMeta?.mode;
        const authHeader = RequestContext.getRequest()?.getHeader(AUTHORIZATION_HEADER);

        if (!mode || mode.kind === 'public') {
            // Public: best-effort parse so a logged-out page can still know the logged-in user.
            this.bestEffortJwt(authHeader);
            this.reconcileWireTrust(/*callerVerified*/ false);
            return nextFilter.invoke(meta);
        }

        switch (mode.kind) {
            case 'jwt':
                this.enforceJwt(authHeader, mode.requirement);
                break;
            case 'oidc':
                await this.enforceOidc(authHeader, mode.callers);
                break;
            case 'shared-secret':
                this.enforceSharedSecret(this.credential(authHeader, SHARED_SECRET_SCHEME), mode.secretKey);
                break;
            case 'local-only':
                this.enforceLocalOnly(meta);
                break;
        }
        this.reconcileWireTrust(AuthFilter.verifiesCaller(mode));
        return nextFilter.invoke(meta);
    }

    /**
     * Does this mode authenticate the CALLER ITSELF (as opposed to a user, or nobody)? The INBOUND
     * twin of {@link DestinationTrust.forAuthMode}, and deliberately the same question: the client
     * omits trusted keys for a destination that cannot verify it, and the server rejects trusted keys
     * on a route that cannot verify the sender. One rule, two ends — if they disagreed, every call
     * would fail with a 401 that looks like a framework bug.
     *
     * - `oidc` / `shared-secret` → TRUE. An internal service is on the other end and the trusted
     *   context it forwarded may be believed. This is what makes cross-service identity propagation
     *   work.
     * - `jwt` / `public` → FALSE. A user JWT proves who the USER is; the SENDER is still whoever
     *   holds the token, i.e. a browser.
     * - `local-only` → FALSE. It verifies WHERE WE ARE RUNNING, not who is calling — anything on
     *   localhost reaches it, and it has no authenticator, so nothing can ever vouch for an inbound
     *   trusted header. Any such header therefore rejects the request, which is exactly right.
     *
     * An exhaustive switch with NO `default`, returning on every branch: a sixth AuthMode kind is a
     * COMPILE error here (TS7030, no ending return) rather than silently landing on one posture. The
     * boolean expression this replaced defaulted every future mode to "not verified" — the safe
     * answer, but arrived at by accident rather than by decision.
     */
    // webpieces-disable no-function-outside-class -- static pure mapping from the AuthMode union, kept beside its only caller (mirrors DestinationTrust.forAuthMode)
    private static verifiesCaller(mode: AuthMode): boolean {
        switch (mode.kind) {
            case 'oidc':
            case 'shared-secret':
                return true;
            case 'jwt':
            case 'public':
            case 'local-only':
                return false;
        }
    }

    /**
     * Decide what happens to the trusted keys that arrived on the WIRE and were held back by
     * {@link PendingWireTrust} (read that class for why they are held rather than written).
     *
     * `callerVerified` — the endpoint authenticated the SENDER (`@AuthOidc`, `@AuthSharedSecret`).
     * The sender is a service we trust, this is the service-to-service hop, and its forwarded
     * identity is admitted as-is. This is the case that makes propagating a verified userId across
     * internal services work.
     *
     * Otherwise the sender is a browser or anyone else with curl, and the ONLY acceptable inbound
     * trusted value is one the authenticator independently derived to the same value. Everything
     * else is rejected — see {@link requireVouched}.
     *
     * Runs AFTER the mode enforcement above, because that is what stamps the authenticator's own
     * values (`applyAuthValues`); comparing before it ran would compare against nothing.
     */
    private reconcileWireTrust(callerVerified: boolean): void {
        const pending = PendingWireTrust.takeAll();
        for (const item of pending) {
            if (callerVerified) {
                RequestContext.putTrusted(item.key, item.value);
            } else {
                this.requireVouched(item);
            }
        }
    }

    /**
     * On a browser-reachable route, an inbound trusted header must match what the authenticator
     * itself derived, or the request dies. Both failure shapes are rejections, not repairs:
     *
     * - DIFFERENT value — the caller said `alice`, the credential says `bob`. Silently letting the
     *   credential win is not safe, because upstream rate limiters commonly bucket on the header
     *   rather than the token: the request was already counted against the wrong principal, so
     *   every forged header would be a free rate-limit bypass. No honest caller contradicts its own
     *   credential.
     * - NOTHING vouched for it — nobody derived this key at all, so there is no evidence behind a
     *   value a stranger typed. This is the common case, not the exotic one: the framework's
     *   {@link DefaultJwtHook} stamps NO entries, and an app hook only stamps the keys it can prove,
     *   so any other trusted key a caller sends lands here.
     *
     * The pending value is discarded either way — the throw is what leaves the request.
     */
    private requireVouched(item: PendingTrustedValue): void {
        const vouched = RequestContext.getTrusted(item.key);
        if (vouched === item.value) {
            return;
        }
        log.error(
            `Rejecting inbound '${item.key.httpHeader}': it is a TRUSTED context key, this route does ` +
            `not authenticate its caller, and the credential ` +
            (vouched === undefined ? 'vouched for no such value' : 'derived a different value') + '.',
        );
        throw new HttpUnauthorizedError(
            `Header '${item.key.httpHeader}' cannot be supplied by the caller on this endpoint`,
        );
    }

    /**
     * `@AuthLocalOnly`: serve only on a developer's machine, and off-local behave EXACTLY as if the
     * endpoint did not exist.
     *
     * WHY 404 AND NOT THE 403 APPS HAND-ROLLED. Off-local the route is not registered at all
     * (`ApiRoutingFactory` skips it), so the ordinary way to reach this path already answers 404. A
     * 403 from here would be a DIFFERENT answer from the same framework for the same endpoint, and
     * the difference is itself the leak: 403 confirms "this path exists in production, you merely
     * lack permission", which is a map of the dev-only surface for anyone probing. A local-only
     * endpoint should not admit it exists. Both gates therefore return the same 404, and this one is
     * the backstop for routes registered by hand through `RouteBuilder` rather than by
     * `ApiRoutingFactory`.
     *
     * The log line names WHICH reason applies, because "you are deployed" and "nobody declared a
     * locality" have completely different fixes and both look like a bare 404 from outside.
     */
    private enforceLocalOnly(meta: MethodMeta): void {
        if (RuntimeLocality.isLocalDevelopment()) {
            return;
        }
        log.warn(
            `Refusing @AuthLocalOnly endpoint ${meta.routeMeta.path}: ` +
            (RuntimeLocality.isDeclared()
                ? 'this process declared itself DEPLOYED.'
                : 'no startup declared a RuntimeLocality, so this process is treated as DEPLOYED. ' +
                  'Pass the locality into RuntimeSetupOptions if this really is a developer machine.'),
        );
        // Same shape as an unregistered route — see the method doc for why this is not a 403.
        throw new EndpointNotFoundError(`No endpoint at ${meta.routeMeta.path}`);
    }

    private enforceJwt(header: string | undefined, requirement: JwtRequirement): void {
        const token = this.credential(header, BEARER_SCHEME);
        if (!token) {
            throw new HttpUnauthorizedError('Authentication required');
        }
        if (!this.jwtHook) {
            throw new HttpUnauthorizedError('User-JWT auth is not enabled on this server');
        }
        const values = this.jwtHook.parseJwt(token); // AUTHENTICATE — throws HttpUnauthorizedError if invalid
        this.applyAuthValues(values);
        this.jwtHook.authorizeJwt(values, requirement); // AUTHORIZE — app policy; throws HttpForbiddenError to deny
    }

    private async enforceOidc(header: string | undefined, callers: string[]): Promise<void> {
        const token = this.credential(header, BEARER_SCHEME);
        if (!token) {
            throw new HttpUnauthorizedError('Missing OIDC bearer token for @AuthOidc endpoint');
        }
        // App-bound OidcHook overrides the caller policy; otherwise the framework default runs directly.
        if (this.oidcHook) {
            await this.oidcHook.verifyOidc(token, callers);
        } else {
            await this.oidcVerifier.verify(token, callers);
        }
    }

    /** `provided` is the Authorization bearer value — the secret itself, same header as a JWT. */
    private enforceSharedSecret(provided: string | undefined, secretKey: string): void {
        const accepted = this.authConfig?.sharedSecrets[secretKey];
        if (!accepted || !provided || !this.matchesEither(provided, accepted)) {
            throw new HttpUnauthorizedError('Invalid shared secret for @AuthSharedSecret endpoint');
        }
    }

    /** EITHER secret1 or secret2 passes — the rotation window. Constant-time on each non-empty slot. */
    private matchesEither(provided: string, accepted: SharedSecrets): boolean {
        return (
            (accepted.secret1 !== '' && this.constantTimeEquals(provided, accepted.secret1)) ||
            (accepted.secret2 !== '' && this.constantTimeEquals(provided, accepted.secret2))
        );
    }

    /** Parse a JWT if one is present, else do nothing — used on public routes; never throws. */
    private bestEffortJwt(header: string | undefined): void {
        const token = this.credential(header, BEARER_SCHEME);
        if (!this.jwtHook || !token) {
            return;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- best-effort on a public route: a bad/absent token just means "not logged in", must not fail the request
        try {
            this.applyAuthValues(this.jwtHook.parseJwt(token));
        } catch (err: unknown) {
            const error = toError(err);
            log.debug('Best-effort JWT parse on a public endpoint failed (treating as anonymous): ', error);
        }
    }

    /** Stamp the parsed user's context entries + the principal into the RequestContext. */
    private applyAuthValues(values: AuthValues): void {
        for (const entry of values.entries) {
            // ContextTuple.key is a TRUSTED key by type, so this is the one sanctioned write of a
            // proven identity: the app's JwtHook derived it from a credential we just verified.
            RequestContext.putTrusted(entry.key, entry.value);
        }
        RequestContext.put(PRINCIPAL_KEY, values);
    }

    /**
     * The credential value IF the header carries the expected scheme, else undefined.
     *
     * Strict: a bare value with no scheme, or a value under the WRONG scheme (a shared secret sent
     * where a JWT is expected), yields undefined and the caller 401s.
     */
    private credential(header: string | undefined, scheme: string): string | undefined {
        if (!header) {
            return undefined;
        }
        const prefix = `${scheme} `;
        return header.startsWith(prefix) ? header.substring(prefix.length) : undefined;
    }

    private constantTimeEquals(a: string, b: string): boolean {
        const bufA = Buffer.from(a, 'utf8');
        const bufB = Buffer.from(b, 'utf8');
        if (bufA.length !== bufB.length) {
            return false;
        }
        return timingSafeEqual(bufA, bufB);
    }
}
