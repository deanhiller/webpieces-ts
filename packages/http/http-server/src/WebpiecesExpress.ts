import { Express } from 'express';
import { WebpiecesRouter } from '@webpieces/http-routing';
import { WebpiecesMiddleware } from './WebpiecesMiddleware';
import { WebpiecesRouteCreator } from './WebpiecesRouteCreator';
import { LogManager } from '@webpieces/core-util';

const log = LogManager.getLogger('WebpiecesExpress');

/** The value returned by express `app.listen(...)` (a node http.Server). */
type HttpServer = ReturnType<Express['listen']>;

/**
 * WebpiecesExpress - the express adapter (the ONLY place express lifecycle lives).
 *
 * Wraps a node-only {@link WebpiecesRouter} and binds its routes + filter chain onto an
 * express app that the CALLER owns. Webpieces never constructs express and (except for the
 * opt-in bindAndStartExpress) never calls listen — so a webpieces app can run side-by-side
 * inside a legacy express server.
 *
 * ```typescript
 * const router = await WebpiecesRouterFactory.create(config, { modules });
 * router.addRoutes(SaveApi, SaveController);
 * const server = new WebpiecesExpress(router);
 *
 * // legacy / side-by-side: mount onto an existing app; you own listen + your middleware
 * server.bindExpress(existingApp);
 *
 * // non-legacy: add webpieces global middleware + listen for you
 * await server.bindAndStartExpress(express(), 8080);
 * ```
 */
export class WebpiecesExpress {
    private readonly middleware = new WebpiecesMiddleware();

    constructor(private readonly router: WebpiecesRouter) {}

    /**
     * Mount the webpieces routes (each fully self-contained: own body parse, RequestContext,
     * express-tier + api-tier filter chain, error->JSON) onto the caller's express app.
     *
     * Adds NO global app.use() middleware, so it is safe to attach to a legacy app whose
     * other routes must stay untouched. The caller owns app.listen() and any global middleware.
     */
    bindExpress(app: Express): void {
        const creator = new WebpiecesRouteCreator(
            app,
            this.router.getContainer(),
            this.router.getRouteBuilder(),
            this.middleware,
        );
        const count = creator.mountRegisteredRoutes();
        log.info(`[WebpiecesExpress] Mounted ${count} webpieces route(s) onto express`);
    }

    /**
     * Add the webpieces global middleware (HTML error page, localhost CORS, request logging),
     * bind the routes, then app.listen(port). Convenience for a non-legacy webpieces server
     * where webpieces owns the whole express app. Resolves with the http.Server once listening.
     */
    async bindAndStartExpress(app: Express, port: number = 8080): Promise<HttpServer> {
        // Global middleware layers (outermost first) — only for a webpieces-owned app.
        app.use(this.middleware.globalErrorHandler.bind(this.middleware));
        app.use(this.middleware.corsForLocalhost());
        app.use(this.middleware.logNextLayer.bind(this.middleware));

        this.bindExpress(app);

        return new Promise<HttpServer>(
            (resolve: (server: HttpServer) => void, reject: (err: Error) => void) => {
                const server: HttpServer = app.listen(port, (error?: Error) => {
                    if (error) {
                        log.error(`[WebpiecesExpress] Failed to start on port ${port}:`, error);
                        reject(error);
                        return;
                    }
                    log.info(`[WebpiecesExpress] Listening on http://localhost:${port}`);
                    resolve(server);
                });
            },
        );
    }
}
