import { RouteModule, WebpiecesRouter, FilterDefinition } from '@webpieces/http-routing';
import { RecordingFilter } from '@webpieces/http-server';
import { Server2Api } from '@webpieces/server2-api';
import { Server2Controller } from './controllers/server2-controller';

/**
 * Server2Routes - server2's route group (a {@link RouteModule}): user filters + the one api route.
 * LogApiFilter (request/response logging) + AuthFilter are auto-installed by the framework; add
 * only user filters. server2 authenticates its CALLER (@AuthSharedSecret on Server2Api), so an
 * AuthConfig holding the INTERNAL_API_SECRET value must be bound — CompanyAuthConfig does that from
 * env by default. Priority (higher runs first): 1850 RecordingFilter.
 */
export class Server2Routes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        router.addRoutes(Server2Api, Server2Controller);
    }
}
