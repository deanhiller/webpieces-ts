/**
 * Service interface - Similar to Java WebPieces Service<REQ, RESP>.
 * Represents any component that can process a request and return a response.
 *
 * Used for:
 * - The final invocation at the end of a chain (a controller server-side, `fetch` client-side)
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
 * They wrap the execution of subsequent filters and the final service.
 *
 * Key principles:
 * - STATELESS: No instance variables for request data
 * - COMPOSABLE: Use chain() methods for functional composition
 *
 * ## Why this lives in core-util rather than beside either chain that uses it
 *
 * There are TWO chains in webpieces and they are the same concept pointed in opposite directions:
 *
 * - INBOUND, server side: `Filter<MethodMeta, WpResponse<unknown>>` (@webpieces/http-routing) wraps
 *   the controller invocation.
 * - OUTBOUND, client side: `Filter<ClientRequest, Response>` (@webpieces/http-client-core) wraps the
 *   `fetch`, so a filter can re-point the URL, add headers, or sign the exact serialized bytes.
 *
 * Declaring the abstraction once, in the package both depend on, is what keeps them ONE concept.
 * A second `Filter`/`Service` pair defined beside the client chain would be two spellings of one
 * thing — the shim shape CLAUDE.md rejects — and the two would drift.
 *
 * core-util is browser-safe and dependency-free, and so is this file: it imports nothing.
 */
export abstract class Filter<REQ, RESP> {
    //priority is determined by how it is chained only here
    //DO NOT add priority here

    /**
     * Filter method that wraps the next filter/service.
     *
     * @param meta - Metadata about the method being invoked
     * @param nextFilter - Next filter/service as a Service
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
