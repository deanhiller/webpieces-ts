import { ContainerModuleLoadOptions } from 'inversify';
import { AnyContextKey, SECRETS } from '@webpieces/core-util';
import {
    RouteModule,
    WebpiecesRouter,
    AppWiring,
    Wiring,
    BindingModule,
    AUTH_CONFIG,
    JWT_HOOK,
} from '@webpieces/http-routing';
import { RuntimeClients } from '@webpieces/http-client-node';
import { CompanyHeaders } from '@webpieces/company-core';
import { CompanyAuthConfig, CompanyJwtHook } from '@webpieces/company-svc-core';
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
 * `@provideSingleton()` are auto-registered; these are the manual pieces, all singletons.
 */
export class ApplicationBindings implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void {
        options.bind<Counter>(TYPES.Counter).to(SimpleCounter).inSingletonScope();
        // Shared-secret state: the framework AuthFilter injects AuthConfig for sharedSecret(...).
        // Tests rebind AuthConfig to a stub / test-key config via appOverrides.
        options.bind(AUTH_CONFIG).to(CompanyAuthConfig).inSingletonScope();
        // User JWT mechanism: the framework AuthFilter injects JwtHook for jwt() endpoints.
        // Tests rebind JwtHook to a permissive stub via appOverrides. (OIDC is the framework default.)
        options.bind(JWT_HOOK).to(CompanyJwtHook).inSingletonScope();
        // The ONE shared-secret store for this service's outbound clients, read once.
        options.bind(SECRETS).to(EnvironmentSecrets).inSingletonScope();
    }
}

/** API/token → HTTP client → deployment: Server2Api calls the server2 deployment. */
export class RuntimeClientsModule implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void {
        new RuntimeClients(options).bindRpc(TYPES.Server2Api, Server2Api, 'server2');
    }
}

export class LegacyWiring implements AppWiring {
    getWirings(): Wiring[] {
        return [];
    }
    getBindingModules(): BindingModule[] {
        return [new ApplicationBindings(), new RuntimeClientsModule()];
    }
    getRoutingModules(): RouteModule[] {
        return [new LegacyRoutes()];
    }
    getHeaders(): AnyContextKey[] {
        return [...CompanyHeaders.ALL_HEADERS, ...new AppHeaders().getAllHeaders()];
    }
}
