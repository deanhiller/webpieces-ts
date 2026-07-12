import { ContextKey } from '@webpieces/core-util';

/**
 * Company-wide context keys shared across all company applications.
 *
 * Lives in @webpieces/company-core (shared, browser-safe) - the company-wide
 * lib that ALL projects bring in. Each app returns these from its
 * `AppModules.getHeaders()` (server) / passes them to `HeaderRegistry.configure(...)`
 * (browser) — by convention the company-wide set every server registers.
 *
 * Header layers:
 * 1. WebpiecesCoreHeaders (framework core keys, via platformHeaders=true)
 * 2. CompanyHeaders (company-wide keys) <- YOU ARE HERE
 * 3. AppHeaders (app-specific keys, appended by the app to its getHeaders())
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
     * Get all company context keys as an array.
     */
    static getAllHeaders(): ContextKey[] {
        return [
            CompanyHeaders.TENANT_ID,
            CompanyHeaders.API_VERSION,
            // userId/orgId/roles are FRAMEWORK keys (WebpiecesCoreHeaders), stamped by AuthFilter
            // from the parsed JWT. Redefining them here clashes on the registry's duplicate check.
        ];
    }
}
