import { PlatformHeader } from '@webpieces/http-api';

/**
 * Company-wide headers shared across all company applications.
 *
 * Lives in @webpieces/company-core (shared, browser-safe) - the company-wide
 * lib that ALL projects bring in. Api packages do NOT know about these:
 * - Servers: their modules bind these via PlatformHeadersExtension
 * - Browser: app.config.ts builds a HeaderRegistry from the same class
 *
 * Second tier of the three-tier header system:
 * 1. WebpiecesCoreHeaders (framework core headers)
 * 2. CompanyHeaders (company-wide headers) <- YOU ARE HERE
 * 3. AppHeaders (app-specific headers)
 */
export class CompanyHeaders {
    /**
     * Tenant ID for multi-tenant applications.
     * Used to isolate data and resources by tenant.
     */
    static readonly TENANT_ID = new PlatformHeader(
        'x-tenant-id',
        true,      // transfer to downstream services
        false,     // not secured (it's an ID, not sensitive data)
        true,      // use for metrics dimensions (track per-tenant metrics)
        'tenantId' // MDC key for structured logging
    );

    /**
     * API version for this request.
     * Allows gradual API migration and version-specific behavior.
     */
    static readonly API_VERSION = new PlatformHeader(
        'x-api-version',
        true,
        false,
        true   // use for metrics (track API version usage)
    );

    /**
     * Authorization token for authentication.
     * This is a SECURE header - value will be masked in logs.
     */
    static readonly AUTHORIZATION = new PlatformHeader(
        'authorization',
        true,   // transfer to downstream services
        true,   // SECURED - mask in logs!
        false   // not a metrics dimension
    );

    /**
     * Get all company headers as an array.
     *
     * @returns Array of all company platform headers
     */
    static getAllHeaders(): PlatformHeader[] {
        return [
            CompanyHeaders.TENANT_ID,
            CompanyHeaders.API_VERSION,
            CompanyHeaders.AUTHORIZATION,
        ];
    }
}
