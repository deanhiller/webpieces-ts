import { Filter, MethodMeta, Action, NextFilter } from './Filter';

/**
 * FilterChain - Manages execution of filters in priority order.
 * Similar to Java servlet filter chains.
 *
 * Filters are sorted by priority (highest first) and each filter
 * calls next() to invoke the next filter in the chain.
 *
 * The final "filter" in the chain is the controller method itself.
 */
export class FilterChain {
  private filters: Filter[];

  constructor(filters: Filter[]) {
    // Sort filters by priority (highest first)
    this.filters = [...filters].sort((a, b) => b.priority - a.priority);
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

    const next: NextFilter = new class extends NextFilter {
      async execute(): Promise<Action> {
        if (index < filters.length) {
          const filter = filters[index++];
          return filter.filter(meta, next);
        } else {
          // All filters have been executed, now execute the controller
          return finalHandler();
        }
      }
    };

    return next.execute();
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
