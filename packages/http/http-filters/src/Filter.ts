/**
 * WpResponse - Wraps controller responses for the filter chain.
 *
 * Generic type parameter TResult represents the controller's return type.
 * The filter chain uses WpResponse<unknown> because it handles all response types uniformly.
 *
 * JsonFilter is responsible for:
 * 1. Serializing WpResponse.response to JSON
 * 2. Writing the JSON to the HTTP response body
 */
export class WpResponse<TResult = unknown> {
    response?: TResult;

    constructor(response?: TResult, statusCode: number = 200) {
        this.response = response;
    }

}

/**
 * Service interface - Similar to Java WebPieces Service<REQ, RESP>.
 * Represents any component that can process a request and return a response.
 *
 * Used for:
 * - Final controller invocation
 * - Wrapping filters as services in the chain
 * - Functional composition of filters
 */
export interface Service<REQ, RESP> {
    /**
     * Invoke the service with the given metadata.
     * @param meta - Request metadata
     * @returns Promise of the response
     */
    invoke(meta: REQ): Promise<RESP>;
}

/**
 * Filter abstract class - Similar to Java WebPieces Filter<REQ, RESP>.
 *
 * Filters are STATELESS and can handle N concurrent requests.
 * They wrap the execution of subsequent filters and the controller.
 *
 * Key principles:
 * - STATELESS: No instance variables for request data
 * - COMPOSABLE: Use chain() methods for functional composition
 *
 * For HTTP filters, use Filter<MethodMeta, WpResponse<unknown>>:
 * - MethodMeta: Standardized request metadata (defined in http-server)
 * - WpResponse<unknown>: Wraps any controller response
 */
export abstract class Filter<REQ, RESP> {
    //priority is determined by how it is chained only here
    //DO NOT add priority here

    /**
     * Filter method that wraps the next filter/controller.
     *
     * @param meta - Metadata about the method being invoked
     * @param nextFilter - Next filter/controller as a Service
     * @returns Promise of the response
     */
    abstract filter(meta: REQ, nextFilter: Service<REQ, RESP>): Promise<RESP>;

    /**
     * Chain this filter with another filter.
     * Returns a new Filter that composes both filters.
     *
     * Similar to Java: filter1.chain(filter2)
     *
     * @param nextFilter - The filter to execute after this one
     * @returns Composed filter
     */
    chain(nextFilter: Filter<REQ, RESP>): Filter<REQ, RESP> {
        const self = this;

        return new (class extends Filter<REQ, RESP> {
            async filter(meta: REQ, nextService: Service<REQ, RESP>): Promise<RESP> {
                // Call outer filter, passing next filter wrapped as a Service
                return self.filter(meta, {
                    invoke: (m: REQ) => nextFilter.filter(m, nextService),
                });
            }
        })();
    }

    /**
     * Chain this filter with a final service (controller).
     * Returns a Service that can be invoked.
     *
     * Similar to Java: filter.chain(service)
     *
     * @param svc - The final service (controller) to execute
     * @returns Service wrapping the entire filter chain
     */
    chainService(svc: Service<REQ, RESP>): Service<REQ, RESP> {
        const self = this;

        return {
            invoke: (meta: REQ) => self.filter(meta, svc),
        };
    }
}
