import {
    getApiPath,
    getAuthMeta,
    getEndpoints,
    RouteMetadata,
} from '@webpieces/core-util';
import { MethodMeta, Service, WpResponse } from '@webpieces/http-filters';
import { RequestContext } from '@webpieces/core-context';
import { RouteBuilderImpl } from './RouteBuilderImpl';

/**
 * InProcessApiClientFactory - Creates API client proxies that invoke routes
 * in-process (api-tier filter chain + controller) WITHOUT any HTTP/express overhead.
 *
 * This is the PRIMARY in-process/test builder. It lives in the node-only http-routing
 * package (no express dependency) so both the node-only WebpiecesRouter and the express
 * adapter (WebpiecesRouteCreator) share one code path.
 *
 * The client uses the ApiPrototype class to discover routes via decorators,
 * then creates pre-configured invoker functions for each API method.
 *
 * IMPORTANT: This loops over the API methods (from decorators), NOT all routes.
 * For each API method, it sets up the filter chain ONCE during proxy creation,
 * so subsequent calls reuse the same filter chain (efficient!).
 */
export class InProcessApiClientFactory {
    constructor(private routeBuilder: RouteBuilderImpl) {}

    /**
     * Create an API client proxy for testing.
     *
     * @param apiPrototype - The API prototype class with routing decorators (can be abstract)
     * @returns A proxy that implements the API interface
     *
     * Example:
     * ```typescript
     * const saveApi = factory.createApiClient<SaveApi>(SaveApi);
     * const response = await saveApi.save(request);
     * ```
     */
    // webpieces-disable no-any-unknown -- abstract constructor signature requires any[] args
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T {
        // Get endpoints from the API prototype using @ApiPath/@Endpoint decorators
        const basePath = getApiPath(apiPrototype) || '';
        const endpoints = getEndpoints(apiPrototype) || {};

        // Create proxy object
        // webpieces-disable no-any-unknown -- proxy holds methods of arbitrary API shapes
        const proxy: Record<string, unknown> = {};

        // Loop over API endpoints and create proxy functions
        for (const [methodName, endpointPath] of Object.entries(endpoints)) {
            const httpMethod = 'POST';
            const path = basePath + endpointPath;

            const authMeta = getAuthMeta(apiPrototype, methodName);
            const routeMeta = new RouteMetadata(httpMethod, path, methodName, apiPrototype.name, authMeta);

            // Create invoker service ONCE (sets up filter chain once, not on every call!)
            const service = this.routeBuilder.createRouteInvoker(httpMethod, path);

            // Proxy method creates MethodMeta and calls the pre-configured service
            // webpieces-disable no-any-unknown -- request/response DTO types are erased at proxy level
            proxy[methodName] = async (requestDto: unknown): Promise<unknown> => {
                // Auto-activate a RequestContext if the test did not wrap the call itself
                if (!RequestContext.isActive()) {
                    return RequestContext.run(async () => {
                        return await this.runMethod(routeMeta, requestDto, service);
                    });
                }
                return await this.runMethod(routeMeta, requestDto, service);
            };
        }

        return proxy as T;
    }

    // webpieces-disable no-any-unknown -- DTO types are erased at the routing layer
    private async runMethod(routeMeta: RouteMetadata, requestDto: unknown, service: Service<MethodMeta, WpResponse<unknown>>): Promise<unknown> {
        // Create MethodMeta without headers (in-process mode - no HTTP involved)
        const meta = new MethodMeta(routeMeta, undefined, requestDto);
        const responseWrapper = await service.invoke(meta);
        return responseWrapper.response;
    }
}
