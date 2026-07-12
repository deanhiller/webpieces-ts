import { ContainerModule } from 'inversify';
import { ContextKey } from '@webpieces/core-util';
import { AppModules, RouteModule } from '@webpieces/http-routing';
import { CompanyHeaders } from '@webpieces/company-core';
import { InversifyModule, AppHeaders } from './modules/InversifyModule';
import { AppRoutes } from './AppRoutes';

/**
 * ClientServerAppModules - this app's COMPLETE server-surface declaration ({@link AppModules}):
 * its DI binding modules, its route groups, and its own context-key headers. The ONE declaration
 * used by BOTH the real server (server.ts via bootstrapServer) and every integration test.
 *
 * Built via the static {@link create} factory so server + tests build the SAME object; tests then
 * pass their overrides through {@link CompanySetupOptions.appOverrides} (a DI module loaded last).
 */
export class ClientServerAppModules implements AppModules {
    // webpieces-disable no-function-outside-class -- app-entry factory: server.ts + tests build the AppModules declaration by hand (never DI-injected)
    static create(): ClientServerAppModules {
        return new ClientServerAppModules();
    }

    getBindingModules(): ContainerModule[] {
        return [InversifyModule];
    }

    getRoutingModules(): RouteModule[] {
        return [new AppRoutes()];
    }

    getHeaders(): ContextKey[] {
        // The company-wide key set (all keys across all servers) plus this app's own keys.
        return [...CompanyHeaders.getAllHeaders(), ...AppHeaders.getAllHeaders()];
    }
}
