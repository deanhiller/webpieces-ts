import { ContainerModule } from 'inversify';
import { FilterDefinition, WebpiecesRouter } from '@webpieces/http-routing';
import { ContextFilter, LogApiFilter, RecordingFilter } from '@webpieces/http-server';
import { InversifyModule } from './modules/InversifyModule';
import { AuthFilter } from './filters/AuthFilter';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';

/**
 * App DI modules beyond the standard company set (WebpiecesModule + CompanyHeadersModule,
 * which createCompanyRouter/bootstrapServer add themselves). InversifyModule binds this
 * app's controllers, the outbound Server2 client, the Counter, and app headers.
 */
export const APP_MODULES: ContainerModule[] = [InversifyModule];

/**
 * Configure the app's filters + routes on a WebpiecesRouter. Shared by production
 * (bootstrapServer) and the in-process createApiClient tests, so both exercise the exact
 * same chain. All filters here are api-tier (run in-process AND over HTTP): AuthFilter reads
 * the AUTHORIZATION value from RequestContext, so it works for createApiClient too.
 *
 * Priority order (higher runs first): 2000 ContextFilter → 1900 AuthFilter →
 * 1850 RecordingFilter → 1800 LogApiFilter.
 */
export function configureRoutes(router: WebpiecesRouter): void {
    router.addFilter(new FilterDefinition(2000, ContextFilter, '*'));
    router.addFilter(new FilterDefinition(1900, AuthFilter, '*'));
    router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
    router.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));

    router.addRoutes(SaveApi, SaveController);
    router.addRoutes(PublicApi, PublicController);
}
