import { ContextKey } from '@webpieces/core-util';

/**
 * Company-wide context keys shared across all company applications.
 *
 * Lives in @webpieces/company-core (shared, browser-safe) - the company-wide
 * lib that ALL projects bring in. Passed to `HeaderRegistry.configure(...)` as the
 * `companyHeaders` argument on both server and browser.
 *
 * Second tier of the three-tier header system:
 * 1. WebpiecesCoreHeaders (framework core keys, via platformHeaders=true)
 * 2. CompanyHeaders (company-wide keys) <- YOU ARE HERE
 * 3. AppHeaders (app-specific keys)
 */
export class CompanyHeaders {
    /**
     * Tenant ID for multi-tenant applications. Transferred to downstream services,
     * logged under 'tenantId'.
     */
    static readonly TENANT_ID = new ContextKey('tenantId', 'x-tenant-id');

    /**
     * API version for this request. Allows gradual API migration and
     * version-specific behavior.
     */
    static readonly API_VERSION = new ContextKey('apiVersion', 'x-api-version');

    /**
     * Authorization token for authentication. SECURED - masked in logs.
     */
    static readonly AUTHORIZATION = new ContextKey('authorization', 'authorization', /*isSecured*/ true);

    /**
     * Get all company context keys as an array.
     */
    static getAllHeaders(): ContextKey[] {
        return [
            CompanyHeaders.TENANT_ID,
            CompanyHeaders.API_VERSION,
            CompanyHeaders.AUTHORIZATION,
        ];
    }
}
