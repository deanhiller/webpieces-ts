import { ContainerModuleLoadOptions } from 'inversify';
import { AnyContextKey, SECRETS } from '@webpieces/core-util';
import {
    RouteModule,
    WebpiecesRouter,
    FilterDefinition,
    AppWiring,
    Wiring,
    BindingModule,
    AUTH_CONFIG,
    AUTHORIZATION_HOOK,
    JWT_HOOK,
} from '@webpieces/http-routing';
import { RuntimeClients } from '@webpieces/http-client-node';
import { RecordingFilter } from '@webpieces/http-server';
import { CompanyHeaders } from '@webpieces/company-core';
import { CompanyAuthConfig, CompanyAuthorizationHook, CompanyJwtHook } from '@webpieces/company-svc-core';
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
        options.bind(AUTHORIZATION_HOOK).to(CompanyAuthorizationHook).inSingletonScope();
        // The ONE shared-secret store for every outbound client (RPC + Cloud Tasks), read once.
        options.bind(SECRETS).to(EnvironmentSecrets).inSingletonScope();
    }
}

/** API/token → HTTP client → deployment: Server2Api calls the server2 deployment. */
export class RuntimeClientsModule implements BindingModule {
    configure(options: ContainerModuleLoadOptions): void {
        new RuntimeClients(options).bindRpc(TYPES.Server2Api, Server2Api, 'server2');
    }
}

export class ClientServerWiring implements AppWiring {
    getWirings(): Wiring[] {
        return [];
    }
    getBindingModules(): BindingModule[] {
        return [new ApplicationBindings(), new RuntimeClientsModule()];
    }
    getRoutingModules(): RouteModule[] {
        return [new AppRoutes()];
    }
    getHeaders(): AnyContextKey[] {
        return [...CompanyHeaders.ALL_HEADERS, ...AppHeaders.ALL_HEADERS];
    }
}
