import { Routes, RouteBuilder, FilterDefinition } from '@webpieces/core-meta';
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
    // Global filter - applies to all controllers (pattern '*' matches all)
    routeBuilder.addFilter(
      new FilterDefinition(140, ContextFilter, '*')
    );

    // Scoped filter - applies to all controllers in src/controllers
    routeBuilder.addFilter(
      new FilterDefinition(60, JsonFilter, 'src/controllers/**/*.ts')
    );

    // Example: Admin-only filter (uncomment if you have an AdminAuthFilter)
    // routeBuilder.addFilter(
    //   new FilterDefinition(100, AdminAuthFilter, 'src/controllers/admin/**/*.ts')
    // );

    // Example: Specific controller filter
    // routeBuilder.addFilter(
    //   new FilterDefinition(80, SpecialFilter, '**/SaveController.ts')
    // );
  }
}

