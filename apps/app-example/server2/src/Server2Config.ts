import { ContainerModule } from 'inversify';
import { LoggerFactory, ConsoleLoggerFactory } from '@webpieces/core-util';
import { ApiFactory, WebpiecesRouter, FilterDefinition, WebpiecesConfig } from '@webpieces/http-routing';
import { LogApiFilter, RecordingFilter } from '@webpieces/http-server';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { Server2Api } from '@webpieces/server2-api';
import { Server2Controller } from './controllers/server2-controller';

/**
 * Declare server2's filters + routes on the router's BUILD surface (addRoutes/addFilter, on the
 * concrete {@link WebpiecesRouter}). server2 is an internal service (Server2Api is
 * @Authentication(false)), so there is NO auth filter. All filters are api-tier; server2 needs no
 * app DI modules beyond the standard company set; the controller is auto-scanned via @provideSingleton.
 */
export function configureServer2Routes(apiFactory: WebpiecesRouter): void {
    // Only user filters here; the framework auto-installs ErrorLogFilter + AuthFilter above.
    // server2 is public (@Authentication(false)), so AuthFilter is a no-op and no AuthConfig
    // need be bound.
    apiFactory.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
    apiFactory.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));

    apiFactory.addRoutes(Server2Api, Server2Controller);
}

/**
 * Options for {@link buildServer2ApiFactory} — the server uses the defaults; tests pass
 * overrides. Data-only structure (a class, per the webpieces guidelines).
 */
export class Server2ApiFactoryOptions {
    constructor(
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
        public readonly appOverrides?: ContainerModule,
        public readonly config?: WebpiecesConfig,
    ) {}
}

/**
 * Build THE server2 {@link ApiFactory}: filters + routes (no app-specific modules/headers), the
 * ONE declaration used by BOTH the real server (server.ts via bootstrapServer) and any in-process
 * test. Runs the shared {@link setupCompanyRuntime} sequence.
 */
export async function buildServer2ApiFactory(
    options: Server2ApiFactoryOptions = new Server2ApiFactoryOptions(),
): Promise<ApiFactory> {
    const apiFactory = await setupCompanyRuntime(
        new CompanySetupOptions(options.loggerFactory, [], [], options.appOverrides, options.config),
    );
    configureServer2Routes(apiFactory);
    return apiFactory;
}
