import { Routes, RouteBuilder } from '@webpieces/core-meta';
import { ContextFilter, JsonFilter } from '@webpieces/http-filters';

/**
 * FilterRoutes - Registers filters for the application.
 * Similar to Java FilterRoutes.
 *
 * Filters are executed in priority order (higher numbers first):
 * - 140: ContextFilter (setup AsyncLocalStorage)
 * - 60: JsonFilter (JSON serialization/deserialization)
 *
 * Filters can now be scoped to specific controller files using glob patterns:
 * - filepathPattern: 'src/controllers/admin/**' + '/*.ts' - All admin controllers
 * - filepathPattern: '**' + '/SaveController.ts' - Specific controller file
 * - No pattern = matches all controllers (default behavior)
 */
export class FilterRoutes implements Routes {
  configure(routeBuilder: RouteBuilder): void {
    // Global filter - applies to all controllers (no filepathPattern)
    routeBuilder.addFilter({
      priority: 140,
      filterClass: ContextFilter,
      // No filepathPattern = matches all controllers
    });

    // Scoped filter - applies to all controllers in src/controllers
    routeBuilder.addFilter({
      priority: 60,
      filterClass: JsonFilter,
      filepathPattern: 'src/controllers/**/*.ts',
    });

    // Example: Admin-only filter (uncomment if you have an AdminAuthFilter)
    // routeBuilder.addFilter({
    //   priority: 100,
    //   filterClass: AdminAuthFilter,
    //   filepathPattern: 'src/controllers/admin/**/*.ts',
    // });

    // Example: Specific controller filter
    // routeBuilder.addFilter({
    //   priority: 80,
    //   filterClass: SpecialFilter,
    //   filepathPattern: '**/SaveController.ts',
    // });
  }
}

