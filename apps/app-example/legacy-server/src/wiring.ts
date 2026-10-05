import { AdditionalFilters } from './AdditionalFilters';
import {
    RouteModule,
    WebpiecesRouter,
    FilterDefinition,
    AppWiring,
    Wiring,
    BindingModule,
} from '@webpieces/http-routing';
// The legacy app is SELF-CONTAINED — it shares only the api CONTRACT with the greenfield sibling,
// so its controllers are its OWN copies here.
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';

/**
 * LegacyRoutes - the legacy server's route group (a {@link RouteModule}): its api routes plus any
 * extra user filters. LogApiFilter + AuthFilter are auto-installed by the framework.
 *
 * `additionalFilters` is the extension/test seam (below the auto-installed framework filters): the
 * integration test injects order-recording filters to assert priority + glob scoping.
 */
export class LegacyRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
    }
}

import { ContainerModuleLoadOptions } from 'inversify';
import { RuntimeClients } from '@webpieces/http-client-node';
import { Server2Api, TYPES } from './remote/Server2Client';
import { InversifyModule } from './modules/InversifyModule';

export class ApplicationBindings implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void | Promise<void> {
        return InversifyModule.load(options);
    }
}

export class RuntimeClientsModule implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void {
        new RuntimeClients(options).bindRpc(TYPES.Server2Api, Server2Api, 'server2');
    }
}

import { AnyContextKey } from '@webpieces/core-util';
import { CompanyHeaders } from '@webpieces/company-core';
import { AppHeaders } from './modules/InversifyModule';

export class LegacyWiring implements AppWiring {
    constructor(private readonly additionalFilters: FilterDefinition[] = []) {}
    getWirings(): Wiring[] {
        return [];
    }
    getBindingModules(): BindingModule[] {
        return [new ApplicationBindings(), new RuntimeClientsModule()];
    }
    getRoutingModules(): RouteModule[] {
        return [new AdditionalFilters(this.additionalFilters), new LegacyRoutes()];
    }
    getHeaders(): AnyContextKey[] {
        return [...CompanyHeaders.ALL_HEADERS, ...new AppHeaders().getAllHeaders()];
    }
}
