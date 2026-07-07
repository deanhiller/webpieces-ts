import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { PlatformHeadersExtension, HEADER_TYPES, LogManager } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';

const log = LogManager.getLogger('CompanyHeadersModule');

/**
 * CompanyHeadersModule - the shared company-header DI binding for ALL services.
 *
 * Second tier of the three-tier header system (framework core → company → app).
 * Every express service loads this so ContextFilter transfers x-tenant-id /
 * authorization / x-api-version through its hop. Previously this was copy-pasted
 * per service (client-server's CompanyModule, server2's Server2Module); it now
 * lives once here in the node-only shared svc-core.
 */
export const CompanyHeadersModule = new ContainerModule((options: ContainerModuleLoadOptions) => {
    const companyExtension = new PlatformHeadersExtension(CompanyHeaders.getAllHeaders());
    options.bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(companyExtension);

    log.info(`[CompanyHeadersModule] Registered company platform headers extension with ${companyExtension.headers.length} headers`);
});
