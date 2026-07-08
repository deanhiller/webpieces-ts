import { inject, injectable } from 'inversify';
import {
    getApiPath,
    getEndpoints,
    RouteMetadata,
    ContextMgr,
} from '@webpieces/core-util';
import { provideFrameworkSingleton, RequestContext, HttpRequest, RequestContextReader } from '@webpieces/core-context';
import { MethodMeta } from './MethodMeta';
import { Service, WpResponse } from './Filter';
import { RouteBuilderImpl } from './RouteBuilderImpl';
import { ApiClient, ApiClientProxy } from './ApiClient';
import { ClassType } from './ApiRoutingFactory';
import { fillContext } from './fillContext';

/**
 * ApiClientFactory - THE piece that wires api → Proxy → filters → controller.
 *
 * For an API prototype (its @ApiPath/@Endpoint decorators) it builds a proxy whose methods
 * invoke the composed filter chain (via RouteBuilder.createRouteInvoker) — that proxy IS what
 * createApiClient() returns. {@link apiClients} reuses the SAME proxy per registered api, so the
 * express layer binds each method through it. There is no express dependency here, so the proxy
 * is the single invocation path for BOTH in-process (tests) and HTTP (the express adapter drives
 * the same proxy after publishing the request).
 *
 * @provideFrameworkSingleton so WebpiecesRouter can inject it (it shares the one RouteBuilder).
 */
@provideFrameworkSingleton()
@injectable()
export class ApiClientFactory {
    // Builds request headers the SAME way the real HTTP client does — from the ambient
    // RequestContext — so a credential a test put in context travels as a real request header.
    private readonly contextMgr = new ContextMgr(new RequestContextReader());

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
                // Auto-activate a RequestContext if the caller (a pure in-process test) did not.
                if (!RequestContext.isActive()) {
                    return RequestContext.run(async () => this.runMethod(routeMeta, requestDto, service));
                }
                return this.runMethod(routeMeta, requestDto, service);
            };
        }

        return proxy;
    }

    // webpieces-disable no-any-unknown -- request/response DTOs are erased at the routing boundary
    private async runMethod(routeMeta: RouteMetadata, requestDto: unknown, service: Service<MethodMeta, WpResponse<unknown>>): Promise<unknown> {
        // Only synthesize the request when NONE was published by a transport. The express adapter
        // publishes the HttpRequest from `req` before calling the proxy, so its request wins; a
        // pure in-process call synthesizes one from the ambient context (client-like).
        if (!RequestContext.getRequest()) {
            const headers = new Map<string, string[]>();
            this.contextMgr.buildOutboundHeaders().forEach((value: string, name: string) => {
                headers.set(name.toLowerCase(), [value]);
            });
            RequestContext.setRequest(new HttpRequest(routeMeta.httpMethod, routeMeta.path, headers));
            fillContext();
        }

        const responseWrapper = await service.invoke(new MethodMeta(routeMeta, requestDto));
        return responseWrapper.response;
    }
}
