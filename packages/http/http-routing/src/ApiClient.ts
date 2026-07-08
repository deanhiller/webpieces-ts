import { ClassType } from './ApiRoutingFactory';

/**
 * ApiClientProxy - the in-process client createApiClient(api) returns: a map of method name →
 * invoker(dto) that runs the filter chain → controller. (Cast to the API interface T for callers.)
 */
// webpieces-disable no-any-unknown -- proxy holds methods of arbitrary API shapes; DTOs are erased
export type ApiClientProxy = Record<string, (requestDto: unknown) => Promise<unknown>>;

/**
 * ApiClient - one registered API surface, reified by {@link ApiClientFactory}:
 *  - `api`    : the contract class passed to addRoutes,
 *  - `client` : exactly what createApiClient(api) returns — a proxy whose methods run the
 *               filter chain → controller.
 *
 * That is ALL a transport needs: the express layer reads the api's @ApiPath/@Endpoint decorators
 * to bind each method's HTTP route to the matching `client` method — one-to-one with a test call
 * `client.method(dto)`. The proxy forms the RouteMetadata and drives it through the filters, so
 * the internal RouteBuilder never leaks out. Data-only structure (a class, per the guidelines).
 */
export class ApiClient {
    constructor(
        public readonly api: ClassType,
        public readonly client: ApiClientProxy,
    ) {}
}
