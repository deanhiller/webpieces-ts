import { inject } from 'inversify';
import { provideFrameworkSingleton } from '@webpieces/core-context';
import { HttpUnauthorizedError } from '@webpieces/core-util';
import { GcpOidc } from '@webpieces/gcp-identity';

/**
 * DefaultOidcVerifier - the framework's built-in Google OIDC verifier, injected into
 * {@link AuthFilter} and run directly whenever no app {@link OidcHook} is bound. It is what makes
 * OIDC "just work" with ZERO wiring: http-routing depends on @webpieces/gcp-identity ON PURPOSE so a
 * server that binds nothing still verifies service-to-service OIDC.
 *
 * `verify` honors the endpoint's `@AuthOidc(...callers)` contract exactly: EMPTY (a bare `@AuthOidc()`)
 * = TRUST THE EDGE — verify the token is genuinely Google-signed and let the deployment's `run.invoker`
 * IAM restrict WHO (gcp-identity warns loudly, once, if the service is actually public and thus the
 * edge is NOT the gate). A non-empty list (`@AuthOidc('svc-a')`) enforces that explicit app-level
 * allow-list as defense-in-depth. Off-GCP, gcp-identity mints + accepts a dev token so local dev needs
 * no GCP. Framework code reads NO process.env — an app that wants an env-driven allow-list binds an
 * {@link OidcHook} instead (env read at its composition root), keeping this default env-free and tests
 * parallel-safe.
 */
@provideFrameworkSingleton()
export class DefaultOidcVerifier {
    constructor(
        // webpieces-disable inject-annotation-not-needed-for-concrete-class -- DI-resolved param; the esbuild/vitest path elides type-only imports (no design:paramtypes), so the explicit token is required
        @inject(GcpOidc) private readonly gcpOidc: GcpOidc,
    ) {}

    async verify(token: string, callers: string[]): Promise<void> {
        // callers pass straight through: EMPTY (@AuthOidc() with no callers) = TRUST THE EDGE, a
        // non-empty list enforces the explicit allow-list. Do NOT inject a ['self'] default — that
        // would reject a legitimate cross-SA caller the edge already admitted.
        const result = await this.gcpOidc.verifyFromCallers(token, callers);
        if (!result.ok) {
            throw new HttpUnauthorizedError(`OIDC rejected: ${result.reason ?? 'not an allowed caller'}`);
        }
    }
}
