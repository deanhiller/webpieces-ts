import express, { Express, Request, Response } from 'express';
import { ContainerModule } from 'inversify';
import { LoggerFactory, ConsoleLoggerFactory, ContextKey } from '@webpieces/core-util';
import { ApiFactory, WebpiecesRouter, FilterDefinition } from '@webpieces/http-routing';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
// The legacy app is SELF-CONTAINED — a legacy server must not depend on a greenfield sibling
// server, so its controllers + DI module are its OWN copies here (sharing only the api CONTRACT).
import { SaveController } from './controllers/save-controller';
import { PublicController } from './controllers/public-controller';
import { InversifyModule, AppHeaders } from './modules/InversifyModule';

/** This app's DI modules (beyond the standard company set). */
const APP_MODULES: ContainerModule[] = [InversifyModule];

/** This app's own context keys, registered into the global HeaderRegistry at startup + in tests. */
const APP_HEADERS: ContextKey[] = new AppHeaders().getAllHeaders();

/**
 * The pre-existing LEGACY express app: it already has its own routes and webpieces never
 * touches them. This is the app a legacy team already runs today.
 */
export function createLegacyExpressApp(): Express {
    const app = express();
    app.get('/legacy/ping', (req: Request, res: Response) => {
        res.json({ pong: true });
    });
    return app;
}

/**
 * Options for {@link buildLegacyApiFactory}. Data-only structure (a class, per the guidelines).
 *
 * @param loggerFactory - Logging backend to install; defaults to the console factory.
 * @param appOverrides - DI module loaded LAST, so callers can rebind bindings. The test rebinds
 *   Server2Api to an in-process simulator (prod would call real server2 over HTTP).
 * @param additionalFilters - Extra user filters (below the auto-installed framework
 *   ErrorLogFilter + AuthFilter). Extension/test seam (the test adds order-recording filters).
 */
export class LegacyApiFactoryOptions {
    constructor(
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
        public readonly appOverrides?: ContainerModule,
        public readonly additionalFilters: FilterDefinition[] = [],
    ) {}
}

/**
 * buildLegacyApiFactory - the ONE "webpieces part" the legacy server's main AND its test call.
 * It deals only in the HeaderRegistry + logging + declaring routes/filters on a node-only,
 * EXPRESS-FREE {@link ApiFactory}, then hands it back. The caller picks the transport:
 *   - main → `new WebpiecesExpressRouter(apiFactory).bindExpress(legacyApp)`
 *   - test → `apiFactory.createApiClient(SomeApi)`  (in-process, no HTTP)
 *
 * It runs the shared {@link setupCompanyRuntime} sequence, so headers, logging, and the DI
 * container are identical to the greenfield server.
 */
export async function buildLegacyApiFactory(
    options: LegacyApiFactoryOptions = new LegacyApiFactoryOptions(),
): Promise<ApiFactory> {
    return setupCompanyRuntime(
        new CompanySetupOptions(options.loggerFactory, APP_MODULES, APP_HEADERS, options.appOverrides),
        (apiFactory: WebpiecesRouter) => {
            // ErrorLogFilter + AuthFilter are auto-installed by the framework; add only extra user filters.
            for (const filter of options.additionalFilters) {
                apiFactory.addFilter(filter);
            }
            apiFactory.addRoutes(SaveApi, SaveController);
            apiFactory.addRoutes(PublicApi, PublicController);
        },
    );
}
