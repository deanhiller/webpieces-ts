import {
    RouteModule,
    WebpiecesRouter,
    FilterDefinition,
    ServerWiring,
    ServerWiringOptions,
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
    constructor(private readonly additionalFilters: FilterDefinition[] = []) {}

    configure(router: WebpiecesRouter): void {
        for (const filter of this.additionalFilters) {
            router.addFilter(filter);
        }
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
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

export class LegacyWiring {
    constructor(private readonly additionalFilters: FilterDefinition[] = []) {}
    getRuntimeWiring(): ServerWiring {
        return new ServerWiring(
            'legacy-server',
            new ServerWiringOptions(
                [InversifyModule, RuntimeClientsModule],
                [new LegacyRoutes(this.additionalFilters)],
            ),
        );
    }
}
