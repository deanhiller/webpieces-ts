import { Express } from 'express';
import { ApiFactory, ApiClient } from '@webpieces/http-routing';
import { LogManager } from '@webpieces/core-util';
import { WebpiecesMiddleware, ExpressRouteHandler } from './WebpiecesMiddleware';

const log = LogManager.getLogger('WebpiecesExpressRouter');

/** The value returned by express `app.listen(...)` (a node http.Server). */
type HttpServer = ReturnType<Express['listen']>;

/**
 * WebpiecesExpressRouter - the express layer that sits ON TOP of a node-only
 * {@link ApiFactory} (a WebpiecesRouter). It is the ONLY place express lifecycle lives.
 *
 * It never reaches into routing internals: it asks the ApiFactory for `apiClients()` — each
 * an api + routeMeta + composed filter-chain→controller impl — and binds each to an express
 * route (`app.<verb>(path, handler)`) invoked when the matching HTTP request arrives. The
 * RouteBuilder stays hidden inside the ApiFactory.
 *
 * ```typescript
 * const apiFactory = await WebpiecesRouterFactory.create(config, { appBindings });
 * apiFactory.addRoutes(SaveApi, SaveController);
 * const express = new WebpiecesExpressRouter(apiFactory);
 *
 * // legacy / side-by-side: mount onto an existing app; you own listen + your middleware
 * express.bindExpress(existingApp);
 *
 * // non-legacy: add webpieces global middleware + listen for you
 * await express.bindAndStartExpress(express(), 8080);
 * ```
 */
export class WebpiecesExpressRouter {
    private readonly middleware = new WebpiecesMiddleware();

    constructor(private readonly apiFactory: ApiFactory) {}

    /**
     * Mount the webpieces routes (each fully self-contained: own body parse, RequestContext,
     * express-tier + api-tier filter chain, error→JSON) onto the caller's express app.
     *
     * Adds NO global app.use() middleware, so it is safe to attach to a legacy app whose other
     * routes must stay untouched. The caller owns app.listen() and any global middleware.
     */
    bindExpress(app: Express): void {
        const apiClients = this.apiFactory.apiClients();
        for (const apiClient of apiClients) {
            this.mountApiClient(app, apiClient);
        }
        log.info(`[WebpiecesExpressRouter] Mounted ${apiClients.length} webpieces route(s) onto express`);
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
                        log.error(`[WebpiecesExpressRouter] Failed to start on port ${port}:`, error);
                        reject(error);
                        return;
                    }
                    log.info(`[WebpiecesExpressRouter] Listening on http://localhost:${port}`);
                    resolve(server);
                });
            },
        );
    }

    /**
     * Wrap one ApiClient's impl in an express handler (RequestContext.run, header read, manual
     * JSON body parse, error→ProtocolError) and register it on the app for its method + path.
     */
    private mountApiClient(app: Express, apiClient: ApiClient): void {
        const wrapper = this.middleware.createExpressWrapper(apiClient.impl, apiClient.routeMeta);
        this.registerHandler(
            app,
            apiClient.routeMeta.httpMethod,
            apiClient.routeMeta.path,
            wrapper.execute.bind(wrapper),
        );
    }

    private registerHandler(
        app: Express,
        httpMethod: string,
        path: string,
        expressHandler: ExpressRouteHandler,
    ): void {
        switch (httpMethod.toLowerCase()) {
            case 'get':
                app.get(path, expressHandler);
                break;
            case 'post':
                app.post(path, expressHandler);
                break;
            case 'put':
                app.put(path, expressHandler);
                break;
            case 'delete':
                app.delete(path, expressHandler);
                break;
            case 'patch':
                app.patch(path, expressHandler);
                break;
            default:
                log.warn(`[WebpiecesExpressRouter] Unknown HTTP method: ${httpMethod}`);
        }
    }
}
