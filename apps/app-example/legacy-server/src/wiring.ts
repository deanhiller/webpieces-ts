import { AnyContextKey, SECRETS } from '@webpieces/core-util';
import {
    RouteModule,
    WebpiecesRouter,
    AppWiring,
    Wiring,
    BindModule,
    Binder,
    ClientBindOptions,
    JWT_HOOK,
} from '@webpieces/http-routing';
import { CompanyHeaders } from '@webpieces/company-core';
import { CompanyAuthBindModule, CompanyJwtHook } from '@webpieces/company-svc-core';
// The legacy app is SELF-CONTAINED — it shares only the api CONTRACT with the greenfield sibling,
// so its controllers are its OWN copies here.
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { Counter, SaveController, SimpleCounter } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';
import { Server2Api, TYPES } from './remote/Server2Client';
import { AppHeaders } from './modules/AppHeaders';
import { EnvironmentSecrets } from './modules/EnvironmentSecrets';

/**
 * LegacyRoutes - the legacy server's route group (a {@link RouteModule}): its api routes.
 * LogApiFilter + AuthFilter are auto-installed by the framework.
 */
export class LegacyRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
    }
}

/**
 * ApplicationBindings - the legacy server's DI registrations. Controllers/filters with
 * `@provideSingleton()` are auto-registered; these are the manual pieces, all singletons. The
 * shared-secret AuthConfig comes from the company library's CompanyAuthBindModule.
 */
export class ApplicationBindings implements BindModule {
    configure(binder: Binder): void {
        binder.bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
        // User JWT mechanism: the framework AuthFilter injects JwtHook for jwt() endpoints.
        // Tests rebind JwtHook to a permissive stub via appOverrides. (OIDC is the framework default.)
        binder.bind(JWT_HOOK).to(CompanyJwtHook).inSingletonScope();
        // The ONE shared-secret store for this service's outbound clients, read once.
        binder.bind(SECRETS).to(EnvironmentSecrets).inSingletonScope();
    }
}

/** API/token → HTTP client → deployment: Server2Api calls the server2 deployment. */
export class RuntimeClientsModule implements BindModule {
    configure(binder: Binder): void {
        binder.createRpcClientAndBind(Server2Api, 'server2', new ClientBindOptions<Server2Api>(TYPES.Server2Api));
    }
}

export class LegacyWiring implements AppWiring {
    getWirings(): Wiring[] {
        return [];
    }
    getBindModules(): BindModule[] {
        return [new CompanyAuthBindModule(), new ApplicationBindings(), new RuntimeClientsModule()];
    }
    getRouteModules(): RouteModule[] {
        return [new LegacyRoutes()];
    }
    getHeaders(): AnyContextKey[] {
        return [...CompanyHeaders.ALL_HEADERS, ...new AppHeaders().getAllHeaders()];
    }
}
