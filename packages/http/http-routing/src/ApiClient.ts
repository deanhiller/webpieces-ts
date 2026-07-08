import { RouteMetadata } from '@webpieces/core-util';
import { ClassType } from './ApiRoutingFactory';
import { MethodMeta } from './MethodMeta';
import { Service, WpResponse } from './Filter';

/**
 * ApiClient - one reified endpoint of an API: the API contract it belongs to, its route
 * metadata (http method + path + auth), and the composed `impl` — the filter chain that
 * ends in the controller method, invoked per request.
 *
 * Data-only structure (a class, per the webpieces guidelines). {@link ApiFactory.apiClients}
 * returns the full list; the express layer (WebpiecesExpressRouter) binds each `impl` to a
 * route, so the internal RouteBuilder never leaks to upper layers.
 */
export class ApiClient {
    constructor(
        public readonly api: ClassType,
        public readonly routeMeta: RouteMetadata,
        // webpieces-disable no-any-unknown -- WpResponse<unknown>: the composed impl is response-type-erased at the filter boundary
        public readonly impl: Service<MethodMeta, WpResponse<unknown>>,
    ) {}
}
