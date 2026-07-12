import { RouteModule, WebpiecesRouter, FilterDefinition } from '@webpieces/http-routing';
import { LogApiFilter, RecordingFilter } from '@webpieces/http-server';
import { Server2Api } from '@webpieces/server2-api';
import { Server2Controller } from './controllers/server2-controller';

/**
 * Server2Routes - server2's route group (a {@link RouteModule}): user filters + the one api route.
 * ErrorLogFilter + AuthFilter are auto-installed by the framework; add only user filters. server2
 * is public (@Authentication(false)), so AuthFilter is a no-op and no AuthConfig need be bound.
 * Priority (higher runs first): 1850 RecordingFilter → 1800 LogApiFilter.
 */
export class Server2Routes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        router.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));
        router.addRoutes(Server2Api, Server2Controller);
    }
}
