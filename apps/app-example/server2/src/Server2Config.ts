import { ContainerModule } from 'inversify';
import { LoggerFactory, ConsoleLoggerFactory } from '@webpieces/core-util';
import { ApiFactory, WebpiecesConfig } from '@webpieces/http-routing';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { Server2AppModules } from './Server2AppModules';

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
 * Build THE server2 {@link ApiFactory} from {@link Server2AppModules} — the same server-surface
 * declaration the real server (server.ts) boots. This thin helper lets the e2e test build the
 * in-process {@link ApiFactory} with its own overrides. Runs the shared {@link setupCompanyRuntime}
 * sequence.
 */
export async function buildServer2ApiFactory(
    options: Server2ApiFactoryOptions = new Server2ApiFactoryOptions(),
): Promise<ApiFactory> {
    return setupCompanyRuntime(
        Server2AppModules.create(),
        new CompanySetupOptions(options.loggerFactory, options.appOverrides, options.config),
    );
}
