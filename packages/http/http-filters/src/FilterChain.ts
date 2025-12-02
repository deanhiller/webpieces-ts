import { Filter, MethodMeta, Action, Service } from './Filter';

/**
 * FilterChain - Manages execution of filters in priority order.
 * Similar to Java servlet filter chains.
 *
 * Filters are sorted by priority (highest first) and each filter
 * calls nextFilter.invoke() to invoke the next filter in the chain.
 *
 * The final "filter" in the chain is the controller method itself.
 */
export class FilterChain {
  private filters: Filter[];

  constructor(filters: Filter[]) {
    // Filters are already sorted by priority from FilterMatcher
    // No need to sort again (priority is in FilterDefinition, not Filter)
    this.filters = filters;
  }

  /**
   * Execute the filter chain.
   *
   * @param meta - Method metadata
   * @param finalHandler - The controller method to execute at the end
   * @returns Promise of the action
   */
  async execute(
    meta: MethodMeta,
    finalHandler: () => Promise<Action>
  ): Promise<Action> {
    let index = 0;
    const filters = this.filters;

    // Create Service adapter that recursively calls filters
    const createServiceForIndex = (currentIndex: number): Service<MethodMeta, Action> => {
      return {
        invoke: async (m: MethodMeta): Promise<Action> => {
          if (currentIndex < filters.length) {
            const filter = filters[currentIndex];
            const nextService = createServiceForIndex(currentIndex + 1);
            return filter.filter(m, nextService);
          } else {
            // All filters executed, now execute the controller
            return finalHandler();
          }
        }
      };
    };

    // Start execution with first filter
    const service = createServiceForIndex(0);
    return service.invoke(meta);
  }

  /**
   * Get all filters in the chain (sorted by priority).
   */
  getFilters(): Filter[] {
    return [...this.filters];
  }

  /**
   * Get the number of filters in the chain.
   */
  size(): number {
    return this.filters.length;
  }
}
