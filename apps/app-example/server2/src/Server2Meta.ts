import { WebAppMeta, Routes, ApiRoutingFactory } from '@webpieces/http-routing';
import { ContainerModule } from 'inversify';
import { WebpiecesModule } from '@webpieces/http-server';
import { Server2Api } from '@webpieces/server2-api';
import { Server2Module } from './modules/Server2Module';
import { Server2FilterRoutes } from './routes/Server2FilterRoutes';
import { Server2Controller } from './controllers/server2-controller';

/**
 * Server2Meta - server2's application metadata.
 *
 * server2 IMPLEMENTS @webpieces/server2-api (see service-contract.json) and is
 * called over real HTTP by client-server. It registers the same company-wide
 * headers (via Server2Module) so the magic context flows through this hop.
 */
export class Server2Meta implements WebAppMeta {
    getDIModules(): ContainerModule[] {
        return [WebpiecesModule, Server2Module];
    }

    getRoutes(): Routes[] {
        return [
            new Server2FilterRoutes(),
            new ApiRoutingFactory(Server2Api, Server2Controller),
        ];
    }
}
