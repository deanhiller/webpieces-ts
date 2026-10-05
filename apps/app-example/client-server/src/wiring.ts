import { AnyContextKey, SECRETS } from '@webpieces/core-util';
import {
    RouteModule,
    WebpiecesRouter,
    FilterDefinition,
    AppWiring,
    Wiring,
    BindModule,
    Binder,
    ClientBindOptions,
    AUTHORIZATION_HOOK,
    JWT_HOOK,
} from '@webpieces/http-routing';
import { RecordingFilter } from '@webpieces/http-server';
import { CompanyHeaders } from '@webpieces/company-core';
import { CompanyAuthBindModule, CompanyAuthorizationHook, CompanyJwtHook } from '@webpieces/company-svc-core';
import { SaveApi, PublicApi, SecureApi } from '@webpieces/client-server-api';
import { Counter, SaveController, SimpleCounter } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';
import { SecureController } from './controllers/secure-controller';
import { Server2Api, TYPES } from './remote/Server2Client';
import { AppHeaders } from './modules/AppHeaders';
import { EnvironmentSecrets } from './modules/EnvironmentSecrets';

/**
 * AppRoutes - this app's route group (a {@link RouteModule}): the USER filters + the api routes.
 * LogApiFilter (request/response logging) + AuthFilter are auto-installed by the framework, so this
 * adds only this app's filters. Priority (higher runs first): 1850 RecordingFilter.
 */
export class AppRoutes implements RouteModule {
    configure(router: WebpiecesRouter): void {
        router.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        router.addRoutes(SaveApi, SaveController);
        router.addRoutes(PublicApi, PublicController);
        router.addRoutes(SecureApi, SecureController);
    }
}

/**
 * ApplicationBindings - this app's DI registrations. Controllers and filters with
 * `@provideSingleton()` are auto-registered; these are the manual pieces, all singletons. The
 * shared-secret AuthConfig comes from the company library's CompanyAuthBindModule.
 */
export class ApplicationBindings implements BindModule {
    configure(binder: Binder): void {
        binder.bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
        // User JWT mechanism: the framework AuthFilter injects JwtHook for jwt() endpoints.
        // Tests rebind JwtHook to a permissive stub via appOverrides. (OIDC is the framework default.)
        binder.bind(JWT_HOOK).to(CompanyJwtHook).inSingletonScope();
        binder.bind(AUTHORIZATION_HOOK).to(CompanyAuthorizationHook).inSingletonScope();
        // The ONE shared-secret store for every outbound client (RPC + Cloud Tasks), read once.
        binder.bind(SECRETS).to(EnvironmentSecrets).inSingletonScope();
    }
}

/** API/token → HTTP client → deployment: Server2Api calls the server2 deployment. */
export class RuntimeClientsModule implements BindModule {
    configure(binder: Binder): void {
        binder.createRpcClientAndBind(Server2Api, 'server2', new ClientBindOptions<Server2Api>(TYPES.Server2Api));
    }
}

export class ClientServerWiring implements AppWiring {
    getWirings(): Wiring[] {
        return [];
    }
    getBindModules(): BindModule[] {
        return [new CompanyAuthBindModule(), new ApplicationBindings(), new RuntimeClientsModule()];
    }
    getRouteModules(): RouteModule[] {
        return [new AppRoutes()];
    }
    getHeaders(): AnyContextKey[] {
        return [...CompanyHeaders.ALL_HEADERS, ...AppHeaders.ALL_HEADERS];
    }
}
