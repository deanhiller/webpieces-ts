import { ContainerModule } from 'inversify';
import { LoggerFactory, ConsoleLoggerFactory } from '@webpieces/core-util';
import { ApiFactory, WebpiecesConfig } from '@webpieces/http-routing';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { ClientServerAppModules } from './ClientServerAppModules';

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
 * Build THE client-server {@link ApiFactory} from {@link ClientServerAppModules} — the same
 * server-surface declaration the real server (server.ts) boots. This thin helper exists so the
 * integration tests can supply their overrides (mock the downstream Api, recording config) via
 * {@link CompanySetupOptions} and drive the in-process {@link ApiFactory.createApiClient}. It runs
 * the shared {@link setupCompanyRuntime} sequence, so headers, logging, and the DI container are
 * identical to production.
 */
export async function buildClientServerApiFactory(
    options: ClientServerApiFactoryOptions = new ClientServerApiFactoryOptions(),
): Promise<ApiFactory> {
    return setupCompanyRuntime(
        ClientServerAppModules.create(),
        new CompanySetupOptions(options.loggerFactory, options.appOverrides, options.config),
    );
}
