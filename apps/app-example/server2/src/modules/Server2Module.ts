import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { PlatformHeadersExtension, HEADER_TYPES } from '@webpieces/http-api';
import { CompanyHeaders } from '@webpieces/company-core';
import { LogManager } from '@webpieces/wp-logging';

const log = LogManager.getLogger('Server2Module');

/**
 * Server2Module - server2's DI bindings.
 *
 * Registers the company-wide headers (from @webpieces/company-core) so
 * ContextFilter transfers x-tenant-id / authorization / x-api-version into
 * server2's RequestContext on hop 2 - without this, the context arriving from
 * client-server would be dropped at the door.
 */
export const Server2Module = new ContainerModule((options: ContainerModuleLoadOptions) => {
    const companyExtension = new PlatformHeadersExtension(CompanyHeaders.getAllHeaders());
    options.bind<PlatformHeadersExtension>(HEADER_TYPES.PlatformHeadersExtension).toConstantValue(companyExtension);

    log.info(`[Server2Module] Registered company platform headers extension with ${companyExtension.headers.length} headers`);
});
