import {
    RouteModule,
    WebpiecesRouter,
    FilterDefinition,
    ServerWiring,
    ServerWiringOptions,
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
 * their routes across several RouteModules and compose them in their {@link AppModules}.
 */
export class AppRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
        router.addRoutes(SecureApi, SecureController);
    }
}

import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { RuntimeClients, rpcTarget } from '@webpieces/http-client-node';
import { Server2Api, TYPES } from './remote/Server2Client';
import { InversifyModule } from './modules/InversifyModule';

export const RuntimeClientsModule = new ContainerModule((options: ContainerModuleLoadOptions) => {
    new RuntimeClients(options).bindRpc(
        TYPES.Server2Api,
        Server2Api,
        rpcTarget(Server2Api, 'server2'),
    );
});

export class ClientServerWiring {
    getRuntimeWiring(): ServerWiring {
        return new ServerWiring(
            'client-server',
            new ServerWiringOptions([InversifyModule, RuntimeClientsModule], [new AppRoutes()]),
        );
    }
}
