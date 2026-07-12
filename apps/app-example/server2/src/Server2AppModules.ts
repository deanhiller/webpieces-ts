import { ContainerModule } from 'inversify';
import { ContextKey } from '@webpieces/core-util';
import { AppModules, RouteModule } from '@webpieces/http-routing';
import { Server2Routes } from './Server2Routes';

/**
 * Server2AppModules - server2's server-surface declaration ({@link AppModules}). server2 has no
 * app-specific DI modules and no app-specific headers (it relies on the framework/company set), so
 * those getters return empty; its one route group is {@link Server2Routes}.
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
        return [];
    }
}
