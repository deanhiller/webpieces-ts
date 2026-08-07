import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { AnyContextKey } from '@webpieces/core-util';
import { AppModules, AUTH_CONFIG, RouteModule } from '@webpieces/http-routing';
import { CompanyAuthConfig } from '@webpieces/company-svc-core';
import { CompanyHeaders } from '@webpieces/company-core';
import { Server2Routes } from './Server2Routes';

/**
 * Server2AppModules - server2's server-surface declaration ({@link AppModules}). server2 has no
 * app-specific headers beyond the company-wide set (getHeaders() returns CompanyHeaders); its one
 * route group is {@link Server2Routes}.
 *
 * Its ONE binding is the shared-secret store: `Server2Api` is `@AuthSharedSecret`, so server2 must
 * hold the accepted value for that key or every inbound call 401s. Authenticating the CALLER is also
 * what lets AuthFilter admit the TRUSTED context keys (userId, orgId, roles) the caller forwarded —
 * on an endpoint that cannot verify who is calling, those are rejected instead.
 */
export class Server2AppModules implements AppModules {
    // webpieces-disable no-function-outside-class -- app-entry factory: server.ts + tests build the AppModules declaration by hand (never DI-injected)
    static create(): Server2AppModules {
        return new Server2AppModules();
    }

    getBindingModules(): ContainerModule[] {
        return [
            new ContainerModule((options: ContainerModuleLoadOptions) => {
                options.bind(AUTH_CONFIG).to(CompanyAuthConfig).inSingletonScope();
            }),
        ];
    }

    getRoutingModules(): RouteModule[] {
        return [new Server2Routes()];
    }

    getHeaders(): AnyContextKey[] {
        // server2 registers the company-wide key set (it reads CompanyHeaders.TENANT_ID); it has
        // no app-specific keys of its own.
        return CompanyHeaders.ALL_HEADERS;
    }
}
