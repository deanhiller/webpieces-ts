import { inject, optional } from 'inversify';
import { timingSafeEqual } from 'crypto';
import {
    provideFrameworkSingleton,
    HttpRequest,
    RawHttpRequest,
    RequestContext,
} from '@webpieces/core-context';
import {
    AuthMode,
    ApiEndpointNotFoundError,
    ApiUnauthorizedError,
    ApiImplementationError,
    LogManager,
    RuntimeLocality,
    Surface,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { Filter, Service } from '@webpieces/core-util';
import { WpResponse } from '../WpResponse';
import { MethodMeta } from '../MethodMeta';
import { AuthConfig, AUTH_CONFIG, SharedSecrets } from '../AuthConfig';
import {
    ApiKeyHook,
    API_KEY_HOOK,
    JwtHook,
    JWT_HOOK,
    OidcHook,
    OIDC_HOOK,
    WebhookAuthCallback,
    WEBHOOK_AUTH_CALLBACK,
} from '../AuthHooks';
import { AuthenticatedCallerContext } from '../AuthenticatedCallerContext';
import { VERIFIED_MACHINE_CALLER, VerifiedMachineCaller } from '../AuthorizationHook';
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
 *   Authorization: Webpieces <@WpAuthSharedSecret value>
 *
 * The scheme is REQUIRED. A bare value with no scheme is rejected.
 */
const BEARER_SCHEME = 'Bearer';
const SHARED_SECRET_SCHEME = 'Webpieces';

/**
 * AuthFilter - the ONE framework auth filter, auto-installed just below the error filter on every
 * route. It is TRANSPORT-NEUTRAL: it reads the raw credential from the {@link HttpRequest} in
 * RequestContext (never express), so the SAME check runs over HTTP and via createApiClient.
 *
 * It enforces the endpoint's AuthMode from separately-bound pieces, each OPTIONAL except the OIDC
 * default:
 *  - shared-secret → constant-time compare vs the {@link AuthConfig} secret VALUE (state). No
 *                    AuthConfig bound → no accepted secret → fail fast (401).
 *  - jwt           → the bound {@link JwtHook} (`parseJwt` + `authorizeJwt`, both awaited — an app's
 *                    strategy may reach a JWKS or a datastore). No JwtHook bound → "not enabled"
 *                    (401): JWT needs an app secret + payload shape.
 *  - oidc          → the bound {@link OidcHook} if any, else the framework {@link DefaultOidcVerifier}
 *                    run DIRECTLY — so a server that wires NOTHING still verifies Google OIDC.
 *  - webhook       → the bound {@link WebhookAuthCallback} verifies the VENDOR's signature over the retained
 *                    raw request. No WebhookAuthCallback bound → 401, like jwt: an unverified webhook is
 *                    never waved through because wiring was forgotten.
 *  - apikey        → the bound {@link ApiKeyHook} looks the CUSTOMER's key up (async, over the whole
 *                    header set) and returns the context to seed. No ApiKeyHook bound → 401, like jwt.
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
    private readonly callerContext = new AuthenticatedCallerContext();

    constructor(
        // Framework default, always available — verifies Google OIDC with zero app wiring.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- AuthFilter is DI-resolved via the esbuild/vitest path, which elides type-only imports (no design:paramtypes), so every param needs its explicit token
        @inject(DefaultOidcVerifier) private readonly oidcVerifier: DefaultOidcVerifier,
        // @optional: only bind an AuthConfig to enable @WpAuthSharedSecret endpoints.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(AUTH_CONFIG) private readonly authConfig?: AuthConfig,
        // @optional: only bind a JwtHook to enable @WpAuthJwt endpoints.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(JWT_HOOK) private readonly jwtHook?: JwtHook<never>,
        // @optional: only bind an OidcHook to OVERRIDE the DefaultOidcVerifier caller policy.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(OIDC_HOOK) private readonly oidcHook?: OidcHook,
        // @optional: only bind a WebhookAuthCallback to enable @WpAuthWebhook endpoints. Unbound = every such
        // endpoint 401s, which is the ONE default that must not be the other way round.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional()
        @inject(WEBHOOK_AUTH_CALLBACK)
        private readonly webhookAuthCallback?: WebhookAuthCallback,
        // @optional: only bind an ApiKeyHook to enable @WpAuthApiKey endpoints. Unbound = every such
        // endpoint 401s, for the same reason as the webhook hook above.
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- see above: explicit token required for DI-resolved param
        @optional() @inject(API_KEY_HOOK) private readonly apiKeyHook?: ApiKeyHook,
    ) {
        super();
    }

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
    override async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        const auth = meta.routeMeta.authMeta;
        if (!auth) throw new ApiImplementationError('Every endpoint requires @WpAuth or @WpAuthPublic.');
        if (meta.routeMeta.localOnly) this.enforceLocalOnly(meta);
        if (meta.invocationAuthentication) {
            meta.invocationAuthentication.assertTarget(meta.routeMeta);
            return nextFilter.invoke(meta);
        }
        const header = RequestContext.getRequest()?.getHeader(AUTHORIZATION_HEADER);
        if (auth.methods[0].kind === 'public') {
            await this.bestEffortJwt(header);
            this.callerContext.reconcileWireTrust(false);
            return nextFilter.invoke(meta);
        }
        const selected = await this.authenticateAlternatives(auth.methods, header, meta);
        this.applySurface(selected);
        this.callerContext.reconcileWireTrust(AuthFilter.verifiesCaller(selected));
        return nextFilter.invoke(meta);
    }

    private async authenticateAlternatives(methods: readonly AuthMode[], header: string | undefined, meta: MethodMeta): Promise<AuthMode> {
        for (const method of methods) {
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- failed credentials may try another declared authenticator; invariants propagate
            try {
                await this.authenticateMethod(method, header, meta);
                return method;
            } catch (err: unknown) { // webpieces-disable no-any-unknown -- structured credential rejection at the boundary
                const error = toError(err);
                if (!(error instanceof ApiUnauthorizedError) || methods.length === 1) throw error;
            }
        }
        throw new ApiUnauthorizedError('No declared credential mechanism authenticated this request.');
    }

    private async authenticateMethod(mode: AuthMode, header: string | undefined, meta: MethodMeta): Promise<void> {
        switch (mode.kind) {
            case 'jwt': await this.enforceJwt(header); return;
            case 'oidc': await this.enforceOidc(header, mode.callers); return;
            case 'shared-secret':
                this.enforceSharedSecret(this.credential(header, SHARED_SECRET_SCHEME), mode.secretKey);
                RequestContext.putTrusted(VERIFIED_MACHINE_CALLER, new VerifiedMachineCaller('shared-secret', mode.secretKey));
                return;
            case 'webhook': await this.enforceWebhook(mode.name, meta); return;
            case 'apikey': await this.enforceApiKey(mode.regime, meta); return;
            case 'public': throw new ApiImplementationError('Public is not a protected auth alternative.');
        }
    }

    /**
     * Stamp WHICH KIND OF CALLER this is, from the auth mode that matched — `@WpAuthJwt` is a browser
     * GUI, `@WpAuthApiKey` is an external partner. See {@link Surface}.
     *
     * SET AT THE EDGE ONLY. The surface belongs to the ORIGINAL caller, so a hop that already has one
     * INHERITS it unchanged and this returns immediately. Two different callers put a value there
     * before this runs, and neither may be overwritten:
     *
     * - the MCP bridge, which stamps `llm` before invoking a `@WpMcpAuthJwt` tool through `ApiFactory`
     *   — that in-process hop still runs this filter, and its HTTP auth mode says nothing about the
     *   model on the other end;
     * - a `@WpAuthOidc` service-to-service hop, whose caller's surface arrived on the wire. OIDC is an
     *   internal hop, NOT a surface of its own, so it deliberately maps to `undefined` below and the
     *   propagated value survives.
     *
     * Running BEFORE {@link reconcileWireTrust} is what makes the trusted-header rule work for this
     * key: on a `@WpAuthJwt` edge a caller who also SENDS `x-wp-surface` must match the value the
     * framework just derived, and on a public route nothing vouches for it at all, so it is a 401.
     */
    private applySurface(mode: AuthMode): void {
        if (RequestContext.getTrusted(WebpiecesCoreHeaders.SURFACE) !== undefined) {
            return;
        }
        const surface = AuthFilter.surfaceFor(mode);
        if (surface !== undefined) {
            RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, surface);
        }
    }

    /**
     * The auth mode -> {@link Surface} table, and the ONE place it is written down.
     *
     * `undefined` means "this mode is not a surface", which is a different statement from "unknown":
     * `oidc` and `shared-secret` are internal hops that RELAY somebody else's surface, `webhook`'s
     * sender is a vendor with no webpieces surface at all, and `local-only` is a developer's own box.
     *
     * An exhaustive switch with NO `default`, like {@link verifiesCaller} and
     * `DestinationTrust.forAuthMode`: a new AuthMode kind must fail to compile here rather than
     * silently landing on `gui` (which would publish 266 to a partner) or on `public-api` (which would
     * publish a real 4xx to a GUI).
     */
    // webpieces-disable no-function-outside-class -- static pure mapping from the AuthMode union, kept beside its only caller (mirrors verifiesCaller)
    private static surfaceFor(mode: AuthMode): Surface | undefined {
        switch (mode.kind) {
            case 'jwt':
                return 'gui';
            case 'apikey':
                return 'public-api';
            case 'oidc':
            case 'shared-secret':
            case 'webhook':
            case 'public':
                return undefined;
        }
    }

    /**
     * `@WpAuthWebhook(name)`: hand the app's {@link WebhookAuthCallback} the verbatim request and let it call the
     * VENDOR's own validator. Three ways to fail, all 401, all before the controller is entered:
     *
     * 1. NO hook bound — the endpoint is not enabled. Matches {@link JwtHook}'s documented behavior;
     *    an unverified webhook must never be waved through because wiring was forgotten.
     * 2. NO raw request — the transport kept no bytes. `assertEveryWebhookEndpointRetainsRawBody`
     *    normally makes this a startup error, so reaching it means either a hand-registered route or
     *    an in-process caller (a spec) that published an HttpRequest with no {@link RawRequest}. The
     *    message says which fix applies rather than leaving a bare 401.
     * 3. The hook threw — the signature did not verify.
     *
     * Case 2 is checked HERE and nowhere else. {@link hasRawBytes} narrows the request to
     * {@link RawHttpRequest} at this one gate, so the hook's signature promises `raw` is present and
     * no vendor implementation ever writes `raw!` or a guard of its own.
     */
    private async enforceWebhook(name: string, meta: MethodMeta): Promise<void> {
        if (!this.webhookAuthCallback) {
            log.warn(
                `Refusing @WpAuthWebhook('${name}') endpoint ${meta.routeMeta.path}: no WebhookAuthCallback is bound. ` +
                    `Bind one (options.bind(WEBHOOK_AUTH_CALLBACK).to(YourWebhookAuthCallback)) to enable webhook verification.`,
            );
            throw new ApiUnauthorizedError('Webhook auth is not enabled on this server');
        }
        const request = RequestContext.getRequest();
        if (!this.hasRawBytes(request)) {
            log.warn(
                `Refusing @WpAuthWebhook('${name}') endpoint ${meta.routeMeta.path}: the inbound request carries ` +
                    `no raw bytes. Declare @Endpoint(POST, path, WRITE, EXTERNAL, { calledBy: '${name}', rawBody: true }); a ` +
                    `spec driving this route in-process must publish an HttpRequest built with a RawRequest.`,
            );
            throw new ApiUnauthorizedError(
                'Webhook signature cannot be verified: no raw request was retained',
            );
        }
        // Throws ApiUnauthorizedError to deny. On success the vendor account the signature proved is
        // stamped through the SAME path a jwt or api-key caller takes.
        const caller = await this.webhookAuthCallback.verifyWebhook(name, request);
        this.callerContext.publish(caller);
    }

    /**
     * The ONE place the framework decides a request carries the verbatim bytes. A TYPE PREDICATE, so
     * the `true` branch hands {@link enforceWebhook} a {@link RawHttpRequest} with no cast and no
     * non-null assertion — the bad state stops being representable past this line rather than being
     * re-thrown about by every hook.
     */
    private hasRawBytes(request: HttpRequest | undefined): request is RawHttpRequest {
        return request?.raw !== undefined;
    }

    /**
     * `@WpAuthApiKey(regime, credentials)`: hand the app's {@link ApiKeyHook} the regime name and the inbound
     * headers and let it look the CUSTOMER's key up. The declared `credentials` are NOT read here — they
     * describe the contract for generators; the hook owns extraction. Three ways to fail, all 401, all
     * before the controller:
     *
     * 1. NO hook bound — the endpoint is not enabled. Matches {@link JwtHook}'s documented behavior; an
     *    unverified partner request must never be waved through because wiring was forgotten.
     * 2. NO inbound request in scope — there are no headers to read, so there is nothing to verify. That
     *    means a caller drove this route without publishing an HttpRequest; the message says so rather
     *    than leaving a bare 401.
     * 3. The hook threw — the key, or the key/organization pair, did not check out.
     *
     * On success the hook's {@link AuthenticatedCaller} is stamped exactly as a jwt parse's is, which is
     * what puts the resolved organization into `RequestContext` for every downstream repository call.
     */
    private async enforceApiKey(regime: string, meta: MethodMeta): Promise<void> {
        if (!this.apiKeyHook) {
            log.warn(
                `Refusing @WpAuthApiKey('${regime}') endpoint ${meta.routeMeta.path}: no ApiKeyHook is bound. ` +
                    `Bind one (options.bind(API_KEY_HOOK).to(YourApiKeyHook)) to enable api-key verification.`,
            );
            throw new ApiUnauthorizedError('API-key auth is not enabled on this server');
        }
        const request = RequestContext.getRequest();
        if (!request) {
            log.warn(
                `Refusing @WpAuthApiKey('${regime}') endpoint ${meta.routeMeta.path}: no inbound HttpRequest is ` +
                    `in scope, so the hook has no headers to read. A spec driving this route in-process must ` +
                    `publish an HttpRequest carrying the api-key headers.`,
            );
            throw new ApiUnauthorizedError(
                'API key cannot be verified: no inbound request was published',
            );
        }
        // Throws ApiUnauthorizedError to deny. The hook gets the WHOLE request so it can cross-check
        // the key against a second header (the organization the customer is acting for).
        const caller = await this.apiKeyHook.verifyApiKey(regime, request);
        this.callerContext.publish(caller);
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
     * - `apikey` → FALSE. See the comment on that branch: the sender is a CUSTOMER.
     *
     * An exhaustive switch with NO `default`, returning on every branch: a new AuthMode kind is a
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
            // `webhook` DOES authenticate its sender — but the sender is an outside VENDOR, not a
            // peer in this repo, and a vendor neither speaks nor forwards webpieces context headers.
            // So there is no forwarded identity to believe, and admitting one would mean trusting a
            // key a vendor's payload could carry. Same answer as the OUTBOUND half
            // (DestinationTrust.forAuthMode), which is the invariant that keeps the two ends agreeing.
            case 'webhook':
            // `apikey` authenticates the SENDER — but the sender is a CUSTOMER's codebase, not a peer
            // service in this repo, so its forwarded trusted context is exactly what must NOT be
            // believed: admitting it would let a partner assert another customer's org id on the wire.
            // The hook's OWN derived entries still land (applyAuthenticatedCaller), and reconcileWireTrust then
            // admits an inbound trusted header only when the hook independently derived the same value.
            case 'apikey':
                return false;
        }
    }

    /**
     * `@WpAuthLocalOnly`: serve only on a developer's machine, and off-local behave EXACTLY as if the
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
            `Refusing @WpAuthLocalOnly endpoint ${meta.routeMeta.path}: ` +
                (RuntimeLocality.isDeclared()
                    ? 'this process declared itself DEPLOYED.'
                    : 'no startup declared a RuntimeLocality, so this process is treated as DEPLOYED. ' +
                      'Pass the locality into RuntimeSetupOptions if this really is a developer machine.'),
        );
        // Same shape as an unregistered route — see the method doc for why this is not a 403.
        throw new ApiEndpointNotFoundError(`No endpoint at ${meta.routeMeta.path}`);
    }

    private async enforceJwt(header: string | undefined): Promise<void> {
        const token = this.credential(header, BEARER_SCHEME);
        if (!token) throw new ApiUnauthorizedError('Authentication required');
        if (!this.jwtHook) throw new ApiUnauthorizedError('User-JWT auth is not enabled on this server');
        this.callerContext.publish(await this.jwtHook.parseJwt(token));
    }

    private async enforceOidc(header: string | undefined, callers: readonly string[]): Promise<void> {
        const token = this.credential(header, BEARER_SCHEME);
        if (!token) throw new ApiUnauthorizedError('Missing OIDC bearer token');
        const identity = this.oidcHook
            ? await this.oidcHook.verifyOidc(token, [...callers])
            : await this.oidcVerifier.verify(token, [...callers]);
        if (!identity) throw new ApiImplementationError('OIDC verifier must return its verified machine identity.');
        RequestContext.putTrusted(VERIFIED_MACHINE_CALLER, new VerifiedMachineCaller(identity.mechanism, identity.identity));
    }

    /** `provided` is the Authorization bearer value — the secret itself, same header as a JWT. */
    private enforceSharedSecret(provided: string | undefined, secretKey: string): void {
        const accepted = this.authConfig?.sharedSecrets[secretKey];
        if (!accepted || !provided || !this.matchesEither(provided, accepted)) {
            throw new ApiUnauthorizedError(
                'Invalid shared secret for @WpAuthSharedSecret endpoint',
            );
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
    private async bestEffortJwt(header: string | undefined): Promise<void> {
        const token = this.credential(header, BEARER_SCHEME);
        if (!this.jwtHook || !token) {
            return;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- best-effort on a public route: a bad/absent token just means "not logged in", must not fail the request
        try {
            this.callerContext.publish(await this.jwtHook.parseJwt(token));
        } catch (err: unknown) {
            const error = toError(err);
            if (!(error instanceof ApiUnauthorizedError)) throw error;
            log.debug(
                'Best-effort JWT parse on a public endpoint failed (treating as anonymous): ',
                error,
            );
        }
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
