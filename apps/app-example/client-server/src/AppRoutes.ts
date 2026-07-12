import { RouteModule, WebpiecesRouter, FilterDefinition } from '@webpieces/http-routing';
import { LogApiFilter, RecordingFilter } from '@webpieces/http-server';
import { SaveApi, PublicApi, SecureApi } from '@webpieces/client-server-api';
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';
import { SecureController } from './controllers/secure-controller';

/**
 * AppRoutes - this app's route group (a {@link RouteModule}): the USER filters + the api routes.
 * ErrorLogFilter + AuthFilter are auto-installed by the framework, so this adds only this app's
 * filters. Priority (higher runs first): 1850 RecordingFilter → 1800 LogApiFilter.
 *
 * A named RouteModule replaces the old inline `(router) => { ... }` callback; larger apps split
 * their routes across several RouteModules and compose them in their {@link AppModules}.
 */
export class AppRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        router.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
        router.addRoutes(SecureApi, SecureController);
    }
}
