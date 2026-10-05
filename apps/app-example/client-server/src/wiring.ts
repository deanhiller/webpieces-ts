import {
    RouteModule,
    WebpiecesRouter,
    FilterDefinition,
    AppWiring,
    Wiring,
    BindingModule,
} from '@webpieces/http-routing';
import { RecordingFilter } from '@webpieces/http-server';
import { SaveApi, PublicApi, SecureApi } from '@webpieces/client-server-api';
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';
import { SecureController } from './controllers/secure-controller';

/**
 * AppRoutes - this app's route group (a {@link RouteModule}): the USER filters + the api routes.
 * LogApiFilter (request/response logging) + AuthFilter are auto-installed by the framework, so this
 * adds only this app's filters. Priority (higher runs first): 1850 RecordingFilter.
 *
 * A named RouteModule replaces the old inline `(router) => { ... }` callback; larger apps split
 * their routes across several RouteModules and compose them in their {@link AppWiring}.
 */
export class AppRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
        router.addRoutes(SecureApi, SecureController);
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

export class ClientServerWiring implements AppWiring {
    getWirings(): Wiring[] {
        return [];
    }
    getBindingModules(): BindingModule[] {
        return [new ApplicationBindings(), new RuntimeClientsModule()];
    }
    getRoutingModules(): RouteModule[] {
        return [new AppRoutes()];
    }
    getHeaders(): AnyContextKey[] {
        return [...CompanyHeaders.ALL_HEADERS, ...AppHeaders.ALL_HEADERS];
    }
}
