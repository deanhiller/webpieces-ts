import { ContainerModule } from 'inversify';
import { PlatformHeader, PlatformHeadersExtension, HEADER_TYPES } from '@webpieces/http-api';

/**
 * Company-wide headers shared across all company applications.
 *
 * This module demonstrates the second tier of the three-tier header system:
 * 1. WebpiecesModule (framework core headers)
 * 2. CompanyModule (company-wide headers) ← YOU ARE HERE
 * 3. InversifyModule (app-specific headers)
 *
 * Examples of company-wide headers:
 * - Multi-tenancy: x-tenant-id, x-org-id
 * - Versioning: x-api-version
 * - Authentication: x-session-id
 * - Business context: x-region, x-business-unit
 */
export class CompanyHeaders {
    /**
     * Tenant ID for multi-tenant applications.
     * Used to isolate data and resources by tenant.
     */
    static readonly TENANT_ID = new PlatformHeader(
        'x-tenant-id',
        true,  // transfer to downstream services
        false, // not secured (it's an ID, not sensitive data)
        true   // use for metrics dimensions (track per-tenant metrics)
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
     * Get all company headers as an array.
     *
     * @returns Array of all company platform headers
     */
    static getAllHeaders(): PlatformHeader[] {
        return [
            CompanyHeaders.TENANT_ID,
            CompanyHeaders.API_VERSION,
        ];
    }
}

/**
 * CompanyModule - Company-level DI bindings.
 *
 * Loaded AFTER WebpiecesModule but BEFORE InversifyModule.
 * Provides company-wide services shared across all company applications.
 */
export const CompanyModule = new ContainerModule((options) => {
    const { bind } = options;

    // Create extension with company headers
    const companyExtension = new PlatformHeadersExtension(CompanyHeaders.getAllHeaders());

    // Bind extension for multiInject collection
    bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(companyExtension);

    console.log(`[CompanyModule] Registered company platform headers extension with ${companyExtension.headers.length} headers`);
});
