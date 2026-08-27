import { Filter, Service } from './Filter';

/**
 * FilterChain - Manages execution of filters in priority order.
 * Similar to Java servlet filter chains.
 *
 * Filters arrive ALREADY SORTED by priority (highest first) and each filter calls
 * nextFilter.invoke() to invoke the next filter in the chain. Sorting is the caller's job because
 * priority lives on the DEFINITION (server: `FilterDefinition`, client: `ClientFilterDefinition`),
 * never on the filter itself — see {@link Filter}.
 *
 * The final "filter" in the chain is the `finalHandler` passed to {@link execute}: the controller
 * method on the server, the `fetch` on the client.
 *
 * A filter may invoke the rest of the chain MORE THAN ONCE (the client-side SSRF guard re-invokes it
 * to follow a validated redirect) or NOT AT ALL (an auth filter short-circuiting). Nothing here
 * assumes exactly one pass.
 */
export class FilterChain<REQ, RESP> {
    private filters: Filter<REQ, RESP>[];

    constructor(filters: Filter<REQ, RESP>[]) {
        // Filters are already sorted by priority from FilterMatcher
        // No need to sort again (priority is in FilterDefinition, not Filter)
        this.filters = filters;
    }

    /**
     * Execute the filter chain.
     *
     * @param meta - Request metadata
     * @param finalHandler - The controller method to execute at the end
     * @returns Promise of the response
     */
    async execute(meta: REQ, finalHandler: () => Promise<RESP>): Promise<RESP> {
        const filters = this.filters;

        // Create Service adapter that recursively calls filters
        const createServiceForIndex = (currentIndex: number): Service<REQ, RESP> => {
            return {
                invoke: async (m: REQ): Promise<RESP> => {
                    if (currentIndex < filters.length) {
                        const filter = filters[currentIndex];
                        const nextService = createServiceForIndex(currentIndex + 1);
                        return filter.filter(m, nextService);
                    } else {
                        // All filters executed, now execute the controller
                        return finalHandler();
                    }
                },
            };
        };

        // Start execution with first filter
        const service = createServiceForIndex(0);
        return service.invoke(meta);
    }

    /**
     * Get all filters in the chain (sorted by priority).
     */
    getFilters(): Filter<REQ, RESP>[] {
        return [...this.filters];
    }

    /**
     * Get the number of filters in the chain.
     */
    size(): number {
        return this.filters.length;
    }
}
