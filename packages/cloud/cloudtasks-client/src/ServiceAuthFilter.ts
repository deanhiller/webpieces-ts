import { injectable } from 'inversify';
import { timingSafeEqual } from 'crypto';
import { provideSingleton, MethodMeta } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import { HttpUnauthorizedError, WebpiecesCoreHeaders } from '@webpieces/http-api';
import { verifyOidcFromCallers } from '@webpieces/gcp-identity';
import { LogManager } from '@webpieces/wp-logging';

const log = LogManager.getLogger('ServiceAuthFilter');

/**
 * ServiceAuthFilter - framework filter that enforces the SERVICE-to-service auth modes
 * (@AuthOidc, @AuthSharedSecret). Priority 1950: runs right after ContextFilter (2000)
 * so the credential headers are already in RequestContext, and before app filters.
 *
 * This is what secures Cloud Tasks delivery: a @PubSub endpoint marked @AuthOidc only
 * accepts a request carrying a valid Google OIDC token from an allowed caller SA. The
 * `public` and `jwt` modes are NOT this filter's job (jwt stays in the app AuthFilter).
 */
@provideSingleton()
@injectable()
// webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
export class ServiceAuthFilter extends Filter<MethodMeta, WpResponse<unknown>> {

    // webpieces-disable no-any-unknown -- Filter generic params use unknown for response type flexibility
    override async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        const authMeta = meta.authMeta;
        if (authMeta) {
            const mode = authMeta.mode;
            if (mode.kind === 'oidc') {
                await this.enforceOidc(mode.callers);
            } else if (mode.kind === 'shared-secret') {
                this.enforceSharedSecret(mode.secretEnv);
            }
        }
        return nextFilter.invoke(meta);
    }

    /** Verify a Google OIDC bearer token from an allowed caller service account. */
    private async enforceOidc(callers: string[]): Promise<void> {
        const header = RequestContext.getHeader(WebpiecesCoreHeaders.AUTHORIZATION) as string | undefined;
        const token = this.stripBearer(header);
        if (!token) {
            throw new HttpUnauthorizedError('Missing OIDC bearer token for @AuthOidc endpoint');
        }
        const result = await verifyOidcFromCallers(token, callers);
        if (!result.ok) {
            throw new HttpUnauthorizedError(`OIDC auth failed: ${result.reason ?? 'unknown'}`);
        }
        log.debug(`OIDC caller verified: ${result.email}`);
    }

    /** Constant-time compare of the shared-secret header against process.env[secretEnv]. */
    private enforceSharedSecret(secretEnv: string): void {
        const expected = process.env[secretEnv];
        if (!expected) {
            throw new HttpUnauthorizedError(`Shared secret env '${secretEnv}' is not configured`);
        }
        const provided = RequestContext.getHeader(WebpiecesCoreHeaders.SHARED_SECRET) as string | undefined;
        if (!provided || !this.constantTimeEquals(provided, expected)) {
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
