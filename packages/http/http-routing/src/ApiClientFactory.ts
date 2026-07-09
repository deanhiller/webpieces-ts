import { inject, injectable } from 'inversify';
import {
    getApiPath,
    getEndpoints,
    RouteMetadata,
} from '@webpieces/core-util';
import { provideFrameworkSingleton, RequestContext } from '@webpieces/core-context';
import { MethodMeta } from './MethodMeta';
import { Service, WpResponse } from './Filter';
import { RouteBuilderImpl } from './RouteBuilderImpl';
import { ApiClient, ApiClientProxy } from './ApiClient';
import { ClassType } from './ApiRoutingFactory';

/**
 * Every call through the proxy needs an ambient RequestContext, established ABOVE the api boundary.
 * It is NOT auto-created here: manufacturing one silently would hide a missing top-level filter, and
 * every log line, outbound call, and enqueued task under it would quietly lose its request id.
 */
// webpieces-disable no-function-outside-class -- a guard over ambient state; a class would own nothing
function requireActiveContext(routeMeta: RouteMetadata): void {
    if (RequestContext.isActive()) {
        return;
    }
    throw new Error(
        `${routeMeta.controllerClassName}.${routeMeta.methodName} was called with no active RequestContext. ` +
        `A server transport must wrap each request in RequestContext.run(...) (WebpiecesMiddleware does). ` +
        `In a test, wrap the call yourself: await RequestContext.run(async () => api.foo(req));`,
    );
}

/**
 * ApiClientFactory - THE piece that wires api → Proxy → filters → controller.
 *
 * For an API prototype (its @ApiPath/@Endpoint decorators) it builds a proxy whose methods
 * invoke the composed filter chain (via RouteBuilder.createRouteInvoker) — that proxy IS what
 * createApiClient() returns. {@link apiClients} reuses the SAME proxy per registered api, so the
 * express layer binds each method through it. There is no express dependency here, so the proxy
 * is the single invocation path for BOTH in-process (tests) and HTTP.
 *
 * Establishing the request scope is a PRECONDITION of calling in here, never this class's job. The
 * caller above the api boundary opens `RequestContext.run(...)`, publishes the inbound
 * `HttpRequest`, and calls `RequestContextHeaders.fillFromRequest()` to move its headers into the
 * context. `WebpiecesMiddleware` does all three for you; a non-webpieces transport (or a test
 * driving `createApiClient` directly) must do the same. This proxy only CHECKS that it happened —
 * manufacturing a context here would hide a missing filter and silently strip every request id.
 *
 * @provideFrameworkSingleton so WebpiecesRouter can inject it (it shares the one RouteBuilder).
 */
@provideFrameworkSingleton()
@injectable()
export class ApiClientFactory {
    constructor(@inject(RouteBuilderImpl) private readonly routeBuilder: RouteBuilderImpl) {}

    /**
     * Create an API client proxy (cast to the API interface T). The proxy's methods run the full
     * filter chain + controller; used by tests in-process AND driven by the express adapter.
     */
    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        return this.buildProxy(apiPrototype) as T;
    }

    /**
     * Reify every registered API as an {@link ApiClient} — the contract + its proxy (the
     * createApiClient object). The transport reads the api's decorators to bind each endpoint to
     * the proxy's matching method, so no route metadata needs to leave here.
     */
    apiClients(): ApiClient[] {
        const apis = new Set<ClassType>();
        for (const route of this.routeBuilder.getRoutes()) {
            apis.add(route.definition.apiClass as ClassType);
        }
        // apiClients() just loops createApiClient — the EXACT method tests call — so the platform
        // (HTTP) and tests (in-process) bind the identical proxy, 1-to-1.
        return [...apis].map((api: ClassType) => {
            // webpieces-disable no-any-unknown -- the registered api is an unconstrained ClassType
            const client = this.createApiClient<ApiClientProxy>(api as any);
            return new ApiClient(api, client);
        });
    }

    /** Build the proxy record (method name → invoker) from the API prototype's decorators. */
    // webpieces-disable no-any-unknown -- accepts any ClassType / abstract-constructor API prototype
    private buildProxy(apiPrototype: any): ApiClientProxy {
        const basePath = getApiPath(apiPrototype) || '';
        const endpoints = getEndpoints(apiPrototype) || {};
        const proxy: ApiClientProxy = {};

        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            const httpMethod = 'POST';
            const path = basePath + endpointPath;

            // Use the REGISTERED route's metadata — it carries the real controller name AND api
            // name (so logging/recording read the right one); createRouteInvoker composes its chain.
            const routeMeta = this.routeBuilder.getRouteMeta(httpMethod, path);
            if (!routeMeta) {
                throw new Error(
                    `No registered route for ${apiPrototype.name}.${methodName} (${httpMethod} ${path}) — call addRoutes(api, controller) first.`,
                );
            }
            const service = this.routeBuilder.createRouteInvoker(httpMethod, path);

            // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
            proxy[methodName] = async (requestDto: unknown): Promise<unknown> => {
                requireActiveContext(routeMeta);
                return this.runMethod(routeMeta, requestDto, service);
            };
        }

        return proxy;
    }

    // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
    private async runMethod(routeMeta: RouteMetadata, requestDto: unknown, service: Service<MethodMeta, WpResponse<unknown>>): Promise<unknown> {
        const responseWrapper = await service.invoke(new MethodMeta(routeMeta, requestDto));
        return responseWrapper.response;
    }
}
