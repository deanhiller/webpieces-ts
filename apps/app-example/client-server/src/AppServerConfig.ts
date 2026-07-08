import { ContainerModule } from 'inversify';
import { ContextKey, LoggerFactory, ConsoleLoggerFactory } from '@webpieces/core-util';
import { ApiFactory, WebpiecesRouter, FilterDefinition, WebpiecesConfig } from '@webpieces/http-routing';
import { LogApiFilter, RecordingFilter } from '@webpieces/http-server';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { InversifyModule, AppHeaders } from './modules/InversifyModule';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';

/**
 * App DI modules beyond the standard company set. InversifyModule binds this app's
 * controllers, the outbound Server2 client, and the Counter.
 */
export const APP_MODULES: ContainerModule[] = [InversifyModule];

/**
 * This app's own context keys, registered into the global HeaderRegistry by
 * {@link buildClientServerApiFactory} (server startup AND tests).
 */
export const APP_HEADERS: ContextKey[] = AppHeaders.getAllHeaders();

/**
 * Options for {@link buildClientServerApiFactory} — the server uses the defaults; tests pass
 * overrides. Data-only structure (a class, per the webpieces guidelines).
 */
export class ClientServerApiFactoryOptions {
    constructor(
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
        public readonly appOverrides?: ContainerModule,
        public readonly config?: WebpiecesConfig,
    ) {}
}

/**
 * Build THE client-server {@link ApiFactory}: this app's modules + headers + filters + routes,
 * the ONE declaration used by BOTH the real server (server.ts via bootstrapServer) and every
 * integration test. Tests pass overrides (mock the downstream Api, recording config); the
 * server uses defaults. It runs the shared {@link setupCompanyRuntime} sequence, so headers,
 * logging, and the DI container are identical to production.
 */
export async function buildClientServerApiFactory(
    options: ClientServerApiFactoryOptions = new ClientServerApiFactoryOptions(),
): Promise<ApiFactory> {
    return setupCompanyRuntime(
        new CompanySetupOptions(options.loggerFactory, APP_MODULES, APP_HEADERS, options.appOverrides, options.config),
        (apiFactory: WebpiecesRouter) => {
            // ErrorLogFilter + AuthFilter are auto-installed by the framework; add only this app's
            // USER filters. Priority (higher runs first): 1850 RecordingFilter → 1800 LogApiFilter.
            apiFactory.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
            apiFactory.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));
            apiFactory.addRoutes(SaveApi, SaveController);
            apiFactory.addRoutes(PublicApi, PublicController);
        },
    );
}
