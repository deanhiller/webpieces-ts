import { RouteModule, WebpiecesRouter, FilterDefinition } from '@webpieces/http-routing';
// The legacy app is SELF-CONTAINED — it shares only the api CONTRACT with the greenfield sibling,
// so its controllers are its OWN copies here.
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';

/**
 * LegacyRoutes - the legacy server's route group (a {@link RouteModule}): its api routes plus any
 * extra user filters. ErrorLogFilter + AuthFilter are auto-installed by the framework.
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
