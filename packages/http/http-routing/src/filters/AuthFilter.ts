import { inject, injectable, optional } from 'inversify';
import { timingSafeEqual } from 'crypto';
import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { WebpiecesCoreHeaders, HttpUnauthorizedError } from '@webpieces/core-util';
import { Filter, WpResponse, Service } from '../Filter';
import { MethodMeta } from '../MethodMeta';
import { AuthConfig } from '../AuthConfig';

/** Reserved context key holding the authenticated Principal (stamped after a jwt verify). */
const PRINCIPAL_KEY = '__webpieces_principal__';

/**
 * AuthFilter - the ONE framework auth filter, auto-installed just below the error filter on
 * every route. It is TRANSPORT-NEUTRAL: it reads the raw credential from the {@link HttpRequest}
 * in RequestContext (never express), so the SAME check runs over HTTP and via createApiClient.
 *
 * It enforces the endpoint's AuthMode (public/jwt/oidc/shared-secret) using the injected
 * {@link AuthConfig} — the concrete verifiers are app-provided and container-bound (rebindable
 * in tests), so http-routing needs no crypto / gcp-identity. Replaces the old app AuthFilter +
 * framework ServiceAuthFilter and removes the express/api filter tier.
 */
@provideFrameworkSingleton()
@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response flexibility
export class AuthFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    constructor(
        // @optional: a public-only server need not bind an AuthConfig; a non-public route
        // then fails fast in requireAuthConfig().
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
        if (!mode || mode.kind === 'public') {
            return nextFilter.invoke(meta);
        }

        const request = RequestContext.getRequest();
        switch (mode.kind) {
            case 'jwt':
                this.enforceJwt(request?.getHeader(WebpiecesCoreHeaders.AUTHORIZATION));
                break;
            case 'oidc':
                await this.enforceOidc(request?.getHeader(WebpiecesCoreHeaders.AUTHORIZATION), mode.callers);
                break;
            case 'shared-secret':
                this.enforceSharedSecret(request?.getHeader(WebpiecesCoreHeaders.SHARED_SECRET), mode.secretEnv);
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

    private enforceJwt(header: string | undefined): void {
        const token = this.stripBearer(header);
        if (!token) {
            throw new HttpUnauthorizedError('Authentication required');
        }
        const principal = this.requireAuthConfig().verifyJwt(token);
        RequestContext.put(PRINCIPAL_KEY, principal);
    }

    private async enforceOidc(header: string | undefined, callers: string[]): Promise<void> {
        const token = this.stripBearer(header);
        if (!token) {
            throw new HttpUnauthorizedError('Missing OIDC bearer token for @AuthOidc endpoint');
        }
        await this.requireAuthConfig().verifyOidc(token, callers);
    }

    private enforceSharedSecret(provided: string | undefined, secretEnv: string): void {
        const expected = this.requireAuthConfig().sharedSecret(secretEnv);
        if (!expected || !provided || !this.constantTimeEquals(provided, expected)) {
            throw new HttpUnauthorizedError('Invalid shared secret for @AuthSharedSecret endpoint');
        }
    }

    private stripBearer(header: string | undefined): string | undefined {
        if (!header) {
            return undefined;
        }
        const prefix = 'Bearer ';
        return header.startsWith(prefix) ? header.substring(prefix.length) : header;
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
