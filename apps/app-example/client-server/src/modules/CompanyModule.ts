import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { PlatformHeadersExtension, HEADER_TYPES } from '@webpieces/http-api';
import { CompanyHeaders } from '@webpieces/company-core';

/**
 * CompanyHeaders lives in @webpieces/company-core - the company-wide lib ALL
 * projects (servers + angular) bring in; api packages do NOT know about it.
 * Re-exported here for convenience of existing imports.
 */
export { CompanyHeaders } from '@webpieces/company-core';

/**
 * CompanyModule - Company-level DI bindings.
 *
 * Loaded AFTER WebpiecesModule but BEFORE InversifyModule.
 * Provides company-wide services shared across all company applications.
 *
 * Second tier of the three-tier header system:
 * 1. WebpiecesModule (framework core headers)
 * 2. CompanyModule (company-wide headers) <- YOU ARE HERE
 * 3. InversifyModule (app-specific headers)
 */
export const CompanyModule = new ContainerModule((options: ContainerModuleLoadOptions) => {
    // Create extension with company headers (shared definitions from example-apis)
    const companyExtension = new PlatformHeadersExtension(CompanyHeaders.getAllHeaders());

    // Bind extension for multiInject collection
    options.bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(companyExtension);

    console.log(`[CompanyModule] Registered company platform headers extension with ${companyExtension.headers.length} headers`);
});
