import { Routes, RouteBuilder } from '@webpieces/core-meta';
import { ContextFilter, JsonFilter } from '@webpieces/http-filters';

/**
 * FilterRoutes - Registers filters for the application.
 * Similar to Java FilterRoutes.
 *
 * Filters are executed in priority order (higher numbers first):
 * - 140: ContextFilter (setup AsyncLocalStorage)
 * - 60: JsonFilter (JSON serialization/deserialization)
 */
export class FilterRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    // Register ContextFilter (priority 140)
    routeBuilder.addFilter({
      priority: 140,
      filterClass: ContextFilter,
    });

    // Register JsonFilter (priority 60)
    routeBuilder.addFilter({
      priority: 60,
      filterClass: JsonFilter,
    });
  }
}
