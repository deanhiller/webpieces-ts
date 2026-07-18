import { RouteModule, WebpiecesRouter, FilterDefinition } from '@webpieces/http-routing';
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
