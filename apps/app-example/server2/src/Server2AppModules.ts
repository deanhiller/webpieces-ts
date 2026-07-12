import { ContainerModule } from 'inversify';
import { ContextKey } from '@webpieces/core-util';
import { AppModules, RouteModule } from '@webpieces/http-routing';
import { CompanyHeaders } from '@webpieces/company-core';
import { Server2Routes } from './Server2Routes';

/**
 * Server2AppModules - server2's server-surface declaration ({@link AppModules}). server2 has no
 * app-specific DI modules of its own (getBindingModules() is empty) and no app-specific headers
 * beyond the company-wide set (getHeaders() returns CompanyHeaders); its one route group is
 * {@link Server2Routes}.
 */
export class Server2AppModules implements AppModules {
    // webpieces-disable no-function-outside-class -- app-entry factory: server.ts + tests build the AppModules declaration by hand (never DI-injected)
    static create(): Server2AppModules {
        return new Server2AppModules();
    }

    getBindingModules(): ContainerModule[] {
        return [];
    }

    getRoutingModules(): RouteModule[] {
        return [new Server2Routes()];
    }

    getHeaders(): ContextKey[] {
        // server2 registers the company-wide key set (it reads CompanyHeaders.TENANT_ID); it has
        // no app-specific keys of its own.
        return CompanyHeaders.getAllHeaders();
    }
}
