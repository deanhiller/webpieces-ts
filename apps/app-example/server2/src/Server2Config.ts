import { FilterDefinition, WebpiecesRouter } from '@webpieces/http-routing';
import { ContextFilter, LogApiFilter, RecordingFilter } from '@webpieces/http-server';
import { Server2Api } from '@webpieces/server2-api';
import { Server2Controller } from './controllers/server2-controller';

/**
 * Configure server2's filters + routes on a WebpiecesRouter. Shared by production
 * (bootstrapServer) and any in-process createApiClient test.
 *
 * server2 is an internal service (Server2Api is @Authentication(false)), so there is NO auth
 * filter. All filters are api-tier. server2 needs no app DI modules beyond the standard company
 * set (WebpiecesModule + CompanyHeadersModule, added by bootstrapServer); the controller is
 * auto-scanned via @provideSingleton.
 */
export function configureServer2Routes(router: WebpiecesRouter): void {
    router.addFilter(new FilterDefinition(2000, ContextFilter, '*'));
    router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
    router.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));

    router.addRoutes(Server2Api, Server2Controller);
}
