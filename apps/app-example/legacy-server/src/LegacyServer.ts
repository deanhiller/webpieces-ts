import express, { Express, Request, Response } from 'express';
import type { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { ContainerModule } from 'inversify';
import { LoggerFactory, ConsoleLoggerFactory } from '@webpieces/core-util';
import { ContextFilter, FilterDefinition, WebpiecesRouteCreator } from '@webpieces/http-server';
import { setupCompanyRuntime, CompanySetupOptions } from '@webpieces/company-svc-core';
import { SaveApi, PublicApi } from '@webpieces/client-server-api';
// Reuse the client-server app's real controllers/filters/modules — this example is about
// the WIRING difference (embed onto a pre-existing express app), not new business logic.
import { SaveController } from '../../client-server/src/controllers/save-controller';
import { PublicController } from '../../client-server/src/controllers/public-controller';
import { AuthFilter } from '../../client-server/src/filters/AuthFilter';
import { APP_MODULES, APP_HEADERS } from '../../client-server/src/AppServerConfig';

/**
 * LegacyServerOptions - inputs to {@link startLegacyServer}.
 *
 * Data-only structure (a class, per the webpieces guidelines).
 */
export class LegacyServerOptions {
    /**
     * @param port - Port to listen on. 0 = an ephemeral port (used by the integration test).
     * @param appOverrides - DI module loaded LAST, so callers can rebind bindings. The test
     *   rebinds Server2Api to an in-process simulator (prod would call real server2 over HTTP).
     * @param additionalFilters - Extra filters wired on top of ContextFilter + AuthFilter.
     *   Extension/test seam (the test adds order-recording filters to assert priority + globbing).
     * @param loggerFactory - Logging backend to install; defaults to the console factory.
     */
    constructor(
        public readonly port: number = 0,
        public readonly appOverrides?: ContainerModule,
        public readonly additionalFilters: FilterDefinition[] = [],
        public readonly loggerFactory: LoggerFactory = new ConsoleLoggerFactory(),
    ) {}
}

/**
 * LegacyServerHandle - what {@link startLegacyServer} returns.
 *
 * Data-only structure (a class, per the webpieces guidelines).
 */
export class LegacyServerHandle {
    constructor(
        public readonly server: HttpServer,
        public readonly baseUrl: string,
        public readonly creator: WebpiecesRouteCreator,
    ) {}
}

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

/** Promisified app.listen that resolves with the started HttpServer. */
function listen(app: Express, port: number): Promise<HttpServer> {
    return new Promise<HttpServer>((resolve: (server: HttpServer) => void) => {
        const server = app.listen(port, () => resolve(server));
    });
}

/**
 * startLegacyServer - THE legacy-adoption example: take a pre-existing express app and bolt
 * the webpieces api → filters → controller pipeline onto it WITHOUT webpieces owning the app
 * (no app.use, no listen — the legacy app keeps both).
 *
 * The whole point: it reuses the SAME startup path as the greenfield server and the tests —
 * {@link setupCompanyRuntime} (HeaderRegistry → logging → router+container) — and then hands
 * `router.getContainer()` to {@link WebpiecesRouteCreator}. No hand-rolled container assembly;
 * the embedded routes resolve from the exact same DI container production uses.
 */
export async function startLegacyServer(
    options: LegacyServerOptions = new LegacyServerOptions(),
): Promise<LegacyServerHandle> {
    // 1. The pre-existing legacy app, untouched by webpieces.
    const app = createLegacyExpressApp();

    // 2. The shared runtime setup, identical to the non-legacy server and the in-process tests.
    const router = await setupCompanyRuntime(
        new CompanySetupOptions(options.loggerFactory, APP_MODULES, APP_HEADERS, options.appOverrides),
    );

    // 3. Wire webpieces onto the legacy app, reusing the router's DI container.
    const creator = new WebpiecesRouteCreator(app, router.getContainer());
    creator.wireFilters(
        new FilterDefinition(2000, ContextFilter, '*'),
        new FilterDefinition(1900, AuthFilter, '*'),
        ...options.additionalFilters,
    );
    creator.wireApi(SaveApi, SaveController);
    creator.wireApi(PublicApi, PublicController);

    // 4. The legacy app still owns listen().
    const server = await listen(app, options.port);
    const address = server.address() as AddressInfo;
    return new LegacyServerHandle(server, `http://localhost:${address.port}`, creator);
}
