import { Express } from 'express';
import { Container } from 'inversify';
import {
    ApiRoutingFactory,
    ClassType,
    ExpressRouteHandler,
    FilterDefinition,
    RouteBuilderImpl,
    RouteHandlerWithMeta,
} from '@webpieces/http-routing';
import { WebpiecesMiddleware } from './WebpiecesMiddleware';
import { InProcessApiClientFactory } from './InProcessApiClientFactory';
import { LogManager } from '@webpieces/wp-logging';

/**
 * WebpiecesRouteCreator - Embeddable adapter that mounts the webpieces
 * api -> filters -> controller pipeline onto ANY existing Express app.
 *
 * Legacy Express apps can adopt webpieces incrementally: existing routes and
 * middleware keep working untouched; each wired webpieces route is fully
 * self-contained (own body parsing, own RequestContext, own error->JSON mapping).
 * This class never calls app.use() - it only registers per-route handlers.
 *
 * Usage:
 * ```typescript
 * const app = express();                       // your existing legacy app
 * const container = new Container();
 * await container.load(buildProviderModule()); // picks up @provideSingleton classes
 * await container.load(WebpiecesModule);       // required if you use ContextFilter
 *
 * const creator = new WebpiecesRouteCreator(app, container);
 * creator.wireFilters(
 *     new FilterDefinition(2000, ContextFilter, '*'),
 *     new FilterDefinition(1900, AuthFilter, 'src/controllers/admin/**'),
 * );
 * creator.wireApi(SaveApi, SaveController);    // controller resolved from container
 * creator.wireApi(PublicApi, PublicController);
 * app.listen(8080);
 * ```
 *
 * Notes:
 * - ALL wireFilters() calls must come BEFORE the first wireApi() call. Filter
 *   chains are composed per-route at wireApi time, so late filters would be
 *   silently ignored - we throw instead.
 * - Scoped filter glob patterns match the controller filepath from the
 *   @SourceFile decorator, falling back to the pattern `**\/{ClassName}.ts`.
 * - Want webpieces' localhost CORS? Opt in yourself:
 *   `app.use(new WebpiecesMiddleware().corsForLocalhost())`.
 *
 * This same class is used internally by WebpiecesServerImpl.start(), so the
 * full server and the embeddable adapter share one code path.
 */
const log = LogManager.getLogger('WebpiecesRouteCreator');

export class WebpiecesRouteCreator {
    private routeBuilder: RouteBuilderImpl;
    private middleware: WebpiecesMiddleware;
    private clientFactory: InProcessApiClientFactory;

    /** Locks wireFilters() once the first wireApi() has composed a filter chain. */
    private apisWired = false;

    /**
     * @param app - The Express app to mount routes on (yours - never taken over)
     * @param container - Inversify container used to resolve controllers and filters
     * @param routeBuilder - Internal: WebpiecesServerImpl passes its DI singleton; standalone users omit
     * @param middleware - Internal: WebpiecesServerImpl passes its DI singleton; standalone users omit
     */
    constructor(
        private app: Express,
        container: Container,
        routeBuilder?: RouteBuilderImpl,
        middleware?: WebpiecesMiddleware,
    ) {
        this.routeBuilder = routeBuilder ?? new RouteBuilderImpl();
        this.routeBuilder.setContainer(container);
        this.middleware = middleware ?? new WebpiecesMiddleware();
        this.clientFactory = new InProcessApiClientFactory(this.routeBuilder);
    }

    /**
     * Register filters that wrap every matching route (glob pattern vs controller filepath).
     * Must be called before the first wireApi() - filter chains are composed per-route.
     */
    wireFilters(...defs: FilterDefinition[]): void {
        if (this.apisWired) {
            throw new Error(
                'wireFilters() must be called before wireApi() - filter chains are composed per-route at wireApi time, so filters added later would never run.',
            );
        }
        for (const def of defs) {
            this.routeBuilder.addFilter(def);
        }
    }

    /**
     * Wire an API prototype class (with @ApiPath/@Endpoint decorators) to its
     * controller, mounting one Express route per endpoint with the full filter
     * chain. The controller is resolved from the Inversify container.
     */
    wireApi<TApi, TController extends TApi>(
        apiPrototype: ClassType<TApi>,
        controllerClass: ClassType<TController>,
    ): void {
        this.apisWired = true;

        // Reuses all existing validation: @ApiPath present, controller extends
        // api prototype, every endpoint implemented + has @Authentication.
        const factory = new ApiRoutingFactory(apiPrototype, controllerClass);

        // Mount only the routes added by THIS call
        const routesBefore = this.routeBuilder.getRoutes().length;
        factory.configure(this.routeBuilder);
        const routes = this.routeBuilder.getRoutes();

        for (let i = routesBefore; i < routes.length; i++) {
            this.mountRoute(routes[i]);
        }
    }

    /**
     * Mount every route currently registered on the RouteBuilder.
     * Used by WebpiecesServerImpl.start() where routes were registered up front
     * from WebAppMeta.getRoutes().
     *
     * @returns Number of routes mounted
     */
    mountRegisteredRoutes(): number {
        const routes = this.routeBuilder.getRoutes();
        for (const routeWithMeta of routes) {
            this.mountRoute(routeWithMeta);
        }
        return routes.length;
    }

    /**
     * Create an in-process API client (full filter chain + controller, no HTTP).
     * Same testing story as WebpiecesServer.createApiClient().
     */
    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        return this.clientFactory.createApiClient(apiPrototype);
    }

    /**
     * Escape hatch for advanced wiring (e.g. addRoute with a hand-built RouteDefinition).
     */
    getRouteBuilder(): RouteBuilderImpl {
        return this.routeBuilder;
    }

    /**
     * Compose the filter chain for one route and register it on the Express app.
     */
    private mountRoute(routeWithMeta: RouteHandlerWithMeta): void {
        const service = this.routeBuilder.createRouteHandler(routeWithMeta);
        const routeMeta = routeWithMeta.definition.routeMeta;

        // ExpressWrapper handles the full request/response cycle per route:
        // RequestContext.run, header read, manual JSON body parse, error->ProtocolError
        const wrapper = this.middleware.createExpressWrapper(service, routeMeta);

        this.registerHandler(
            routeMeta.httpMethod,
            routeMeta.path,
            wrapper.execute.bind(wrapper),
        );
    }

    private registerHandler(httpMethod: string, path: string, expressHandler: ExpressRouteHandler): void {
        switch (httpMethod.toLowerCase()) {
            case 'get':
                this.app.get(path, expressHandler);
                break;
            case 'post':
                this.app.post(path, expressHandler);
                break;
            case 'put':
                this.app.put(path, expressHandler);
                break;
            case 'delete':
                this.app.delete(path, expressHandler);
                break;
            case 'patch':
                this.app.patch(path, expressHandler);
                break;
            default:
                log.warn(`[WebpiecesRouteCreator] Unknown HTTP method: ${httpMethod}`);
        }
    }
}
