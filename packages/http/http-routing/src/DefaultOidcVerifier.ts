import { injectable } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { HttpUnauthorizedError } from '@webpieces/core-util';
import { verifyOidcFromCallers } from '@webpieces/gcp-identity';

/**
 * DefaultOidcVerifier - the framework's built-in Google OIDC verifier, injected into
 * {@link AuthFilter} and run directly whenever no app {@link OidcHook} is bound. It is what makes
 * OIDC "just work" with ZERO wiring: http-routing depends on @webpieces/gcp-identity ON PURPOSE so a
 * server that binds nothing still verifies service-to-service OIDC.
 *
 * `verify` checks the token against the endpoint's `@AuthOidc(...callers)` allow-list, falling back
 * to `['self']` (this service's own runtime SA) when the endpoint named none. Off-GCP, gcp-identity
 * mints + accepts a dev token so local dev needs no GCP. Framework code reads NO process.env — an app
 * that wants an env-driven allow-list binds an {@link OidcHook} instead (env read at its composition
 * root), which keeps this default env-free and tests parallel-safe.
 */
@provideFrameworkSingleton()
@injectable()
export class DefaultOidcVerifier {
    async verify(token: string, callers: string[]): Promise<void> {
        const allow = callers.length > 0 ? callers : ['self'];
        const result = await verifyOidcFromCallers(token, allow);
        if (!result.ok) {
            throw new HttpUnauthorizedError(`OIDC rejected: ${result.reason ?? 'not an allowed caller'}`);
        }
    }
}
