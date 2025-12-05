import { Routes, RouteBuilder, FilterDefinition } from '@webpieces/http-routing';
import { ContextFilter, JsonFilter, LogApiFilter } from '@webpieces/http-server';

/**
 * FilterRoutes - Registers filters for the application.
 * Similar to Java FilterRoutes.
 *
 * Filters are executed in priority order (higher numbers first):
 * - 2000: ContextFilter (transfers headers, stores metadata in RequestContext)
 * - 1850: JsonFilter (parses JSON request body, serializes JSON response)
 * - 1800: LogApiFilter (structured API logging)
 *
 * Filter responsibilities:
 * - ContextFilter: Headers from RouterRequest → RequestContext, generate REQUEST_ID
 * - JsonFilter: RouterRequest body → requestDto, responseDto → RouterResponse JSON
 * - LogApiFilter: Log request/response with SUCCESS/FAIL/OTHER categories
 *
 * Filters can be scoped to specific controller files using glob patterns:
 * - filepathPattern: 'src/controllers/admin/**' + '/*.ts' - All admin controllers
 * - filepathPattern: '**' + '/SaveController.ts' - Specific controller file
 * - No pattern = matches all controllers (default behavior)
 */
export class FilterRoutes implements Routes {
    configure(routeBuilder: RouteBuilder): void {
        // Global context filter - applies to all controllers (pattern '*' matches all)
        routeBuilder.addFilter(new FilterDefinition(2000, ContextFilter, '*'));

        // Global JSON filter - parses request body, serializes response
        routeBuilder.addFilter(new FilterDefinition(1850, JsonFilter, '*'));

        // Global API logging filter - applies to all controllers
        routeBuilder.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));

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
