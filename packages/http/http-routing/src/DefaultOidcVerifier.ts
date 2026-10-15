import { inject } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { ApiUnauthorizedError, OidcAuthMethods } from '@webpieces/core-util';
import { AuthenticatedMachineIdentity } from './AuthConfig';
import { GcpOidc } from '@webpieces/gcp-identity';

/**
 * DefaultOidcVerifier - the framework's built-in Google OIDC verifier, injected into
 * {@link AuthFilter} and run directly whenever no app {@link OidcHook} is bound. It is what makes
 * OIDC "just work" with ZERO wiring: http-routing depends on @webpieces/gcp-identity ON PURPOSE so a
 * server that binds nothing still verifies service-to-service OIDC.
 *
 * `verify` honors the endpoint's caller scopes exactly, through `GcpOidc.verify`, which checks the
 * token's signature ONCE and admits the call when ANY declared scope admits the caller:
 * - `oidcSameProject()` (`callerScope: 'same-project'`) — a service account of THIS GCP project. Off
 *   GCP there is no project, so it is open.
 * - `oidcSvcs([...])` (`callerScope: 'services'`) — one of the listed service accounts, which may live
 *   in other projects.
 *
 * Off-GCP, gcp-identity mints + accepts a dev token so local dev needs no GCP; on GCP it refuses one.
 * Framework code reads NO process.env — an app that wants an env-driven allow-list binds an
 * {@link OidcHook} instead (env read at its composition root), keeping this default env-free and tests
 * parallel-safe.
 */
@provideFrameworkSingleton()
export class DefaultOidcVerifier {
    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
    ) {}

    async verify(token: string, methods: OidcAuthMethods): Promise<AuthenticatedMachineIdentity> {
        const result = await this.gcpOidc.verify(token, methods);
        if (!result.ok || !result.email) {
            throw new ApiUnauthorizedError(
                `OIDC rejected: ${result.reason ?? 'not an allowed caller'}`,
            );
        }
        return new AuthenticatedMachineIdentity('oidc', result.email);
    }
}
