import { inject, injectable, optional } from 'inversify';
import { timingSafeEqual } from 'crypto';
import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { HttpUnauthorizedError, JwtRequirement, LogManager, toError } from '@webpieces/core-util';
import { Filter, WpResponse, Service } from '../Filter';
import { MethodMeta } from '../MethodMeta';
import { AuthConfig, AuthValues, SharedSecrets } from '../AuthConfig';

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
 * It enforces the endpoint's AuthMode using the injected app-bound {@link AuthConfig}:
 *  - shared-secret → constant-time compare vs the bound secret VALUE (state).
 *  - jwt           → `parseJwt` → stamp the user's context values + enforce @AuthJwt(...roles).
 *  - oidc          → `verifyOidc` (delegates to gcp-identity in the company layer).
 *  - public        → BEST-EFFORT jwt parse: if a token is present, stamp the user's context so a
 *                    logged-out page still knows who is logged in; never fails.
 *
 * The verifiers/secrets are app-provided (rebindable in tests), so http-routing needs no
 * jsonwebtoken / gcp-identity.
 */
@provideFrameworkSingleton()
@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
export class AuthFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    constructor(
        // @optional: a public-only server need not bind an AuthConfig; a non-public route then
        // fails fast in requireAuthConfig().
        @optional() @inject(AuthConfig) private readonly authConfig?: AuthConfig,
    ) {
        super();
    }

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
    override async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        const mode = meta.authMeta?.mode;
        const authHeader = RequestContext.getRequest()?.getHeader(AUTHORIZATION_HEADER);

        if (!mode || mode.kind === 'public') {
            // Public: best-effort parse so a logged-out page can still know the logged-in user.
            this.bestEffortJwt(authHeader);
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
        }
        return nextFilter.invoke(meta);
    }

    private requireAuthConfig(): AuthConfig {
        if (!this.authConfig) {
            throw new HttpUnauthorizedError('No AuthConfig bound — cannot enforce a non-public endpoint');
        }
        return this.authConfig;
    }

    private enforceJwt(header: string | undefined, requirement: JwtRequirement): void {
        const token = this.credential(header, BEARER_SCHEME);
        if (!token) {
            throw new HttpUnauthorizedError('Authentication required');
        }
        const config = this.requireAuthConfig();
        const values = config.parseJwt(token); // AUTHENTICATE — throws HttpUnauthorizedError if invalid
        this.applyAuthValues(values);
        config.authorizeJwt(values, requirement); // AUTHORIZE — app policy; throws HttpForbiddenError to deny
    }

    private async enforceOidc(header: string | undefined, callers: string[]): Promise<void> {
        const token = this.credential(header, BEARER_SCHEME);
        if (!token) {
            throw new HttpUnauthorizedError('Missing OIDC bearer token for @AuthOidc endpoint');
        }
        await this.requireAuthConfig().verifyOidc(token, callers);
    }

    /** `provided` is the Authorization bearer value — the secret itself, same header as a JWT. */
    private enforceSharedSecret(provided: string | undefined, secretKey: string): void {
        const accepted = this.requireAuthConfig().sharedSecrets[secretKey];
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
        if (!this.authConfig || !token) {
            return;
        }
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- best-effort on a public route: a bad/absent token just means "not logged in", must not fail the request
        try {
            this.applyAuthValues(this.authConfig.parseJwt(token));
        } catch (err: unknown) {
            const error = toError(err);
            log.debug('Best-effort JWT parse on a public endpoint failed (treating as anonymous): ', error);
        }
    }

    /** Stamp the parsed user's context entries + the principal into the RequestContext. */
    private applyAuthValues(values: AuthValues): void {
        for (const entry of values.entries) {
            RequestContext.putHeader(entry.key, entry.value);
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
