import { Express } from 'express';
import { ApiFactory, ApiClient, getApiPath, getEndpoints, isFormPost, WebpiecesConfig } from '@webpieces/http-routing';
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
        let count = 0;
        for (const apiClient of this.apiFactory.apiClients()) {
            count += this.mountApiClient(app, apiClient);
        }
        log.info(`Mounted ${count} webpieces route(s) onto express`);
    }

    /**
     * Add the webpieces global middleware (optional CORS), bind the routes, mount the top-level
     * error handler AFTER them, then app.listen(port). Convenience for a non-legacy webpieces server where
     * webpieces owns the whole express app. Resolves with the http.Server once listening.
     *
     * CORS is mounted ONLY when `config.corsOrigins` is non-empty — see the note below and
     * {@link WebpiecesMiddleware.corsMiddleware}.
     */
    async bindAndStartExpress(
        app: Express,
        port: number = 8080,
        config?: WebpiecesConfig,
    ): Promise<HttpServer> {
        // Global middleware layers (outermost first) — only for a webpieces-owned app.
        // CORS is OPT-IN, and stays OFF in production. A server that serves its own browser app does
        // not need it — a browser applies no cors check to a same-origin request — so mounting it
        // would only hand credentialed cross-origin read access to whatever it allows, for nothing.
        // It is needed solely when a browser on ANOTHER origin calls this api: `ng serve` in dev, or
        // a UI hosted on a different host. Those say so via corsOrigins.
        const corsOrigins = config?.corsOrigins ?? [];
        if (corsOrigins.length > 0) {
            app.use(this.middleware.corsMiddleware(config));
        }

        this.bindExpress(app);

        // Top-level error handler is mounted LAST (AFTER the routes). Express only forwards a
        // downstream failure to a 4-arg error middleware that sits BELOW the failing route — it does
        // NOT bubble errors back up through next(). See WebpiecesMiddleware.errorHandler.
        app.use(this.middleware.errorHandler.bind(this.middleware));

        return new Promise<HttpServer>(
            (resolve: (server: HttpServer) => void, reject: (err: Error) => void) => {
                const server: HttpServer = app.listen(port, (error?: Error) => {
                    if (error) {
                        log.error(`Failed to start on port ${port}:`, error);
                        reject(error);
                        return;
                    }
                    log.info(`Listening on http://localhost:${port}`);
                    this.logStartupBanner(port);
                    resolve(server);
                });
            },
        );
    }

    /**
     * The "Svr Ready!!" ASCII banner, LOCAL DEV ONLY (skipped on Cloud Run, where `K_SERVICE` is set and
     * every line becomes its own structured log entry — a multi-line banner there is pure noise). Copied
     * verbatim from the trytami service so a familiar splash marks "the server is up and reachable".
     */
    private logStartupBanner(port: number): void {
        if (process.env['K_SERVICE']) {
            return;
        }
        log.info(`
 ___                           _____               _
/  _|                          | _ \\             | |
\\ \`--.  _ _ ___   ___ _ _  | |_/ /_  _ _  _| |_   _
 \`--. \\/ _ \\ '_\\ \\ / / _ \\ '_| |    // _ \\/ _\` |/ _\` | | | |
/\\_/ /  _/ |   \\ V /  _/ |    | |\\ \\  _/ (_| | (_| | |_| |
\\___/ \\_|_|    \\_/ \\_|_|    \\_| \\_\\_|\\_,_|\\_,_|\\_, |
                                                         _/ |
                                                        |_/

  Svr Ready!!  port=${port}
`);
    }

    /**
     * Bind EACH method of one ApiClient. The api's @ApiPath/@Endpoint decorators give the paths;
     * for each we wrap the matching client method (the proxy — RequestContext.run + header read +
     * JSON body parse + error→ProtocolError all live in the wrapper/chain) and register the route.
     * This is one-to-one with a test: an HTTP POST maps straight to `client[method](dto)`.
     *
     * @returns the number of routes mounted for this api.
     */
    private mountApiClient(app: Express, apiClient: ApiClient): number {
        const basePath = getApiPath(apiClient.api) || '';
        const endpoints = getEndpoints(apiClient.api) || {};
        let count = 0;
        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            const path = basePath + endpointPath;
            // The parser is chosen by the @Endpoint annotation, not the request Content-Type.
            const wrapper = this.middleware.createExpressWrapper(
                apiClient.client[methodName],
                path,
                isFormPost(apiClient.api, methodName),
            );
            // All webpieces routes are POST (the api-tier convention).
            this.registerHandler(app, 'POST', path, wrapper.execute.bind(wrapper));
            count++;
        }
        return count;
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
                log.warn(`Unknown HTTP method: ${httpMethod}`);
        }
    }
}
