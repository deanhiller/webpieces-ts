import { ContainerModule } from 'inversify';
import { ContextKey } from '@webpieces/core-util';
import { AppModules, RouteModule, FilterDefinition } from '@webpieces/http-routing';
import { InversifyModule, AppHeaders } from './modules/InversifyModule';
import { LegacyRoutes } from './LegacyRoutes';

/**
 * LegacyAppModules - the legacy server's server-surface declaration ({@link AppModules}): its DI
 * bindings, its route group, and its own headers. Built via the static {@link create} factory
 * (which forwards the test-only `additionalFilters` seam into {@link LegacyRoutes}), so the server
 * main and the integration test build the SAME object.
 */
export class LegacyAppModules implements AppModules {
    private constructor(private readonly additionalFilters: FilterDefinition[]) {}

    // webpieces-disable no-function-outside-class -- app-entry factory: server main + tests build the AppModules declaration by hand (never DI-injected)
    static create(additionalFilters: FilterDefinition[] = []): LegacyAppModules {
        return new LegacyAppModules(additionalFilters);
    }

    getBindingModules(): ContainerModule[] {
        return [InversifyModule];
    }

    getRoutingModules(): RouteModule[] {
        return [new LegacyRoutes(this.additionalFilters)];
    }

    getHeaders(): ContextKey[] {
        return new AppHeaders().getAllHeaders();
    }
}
