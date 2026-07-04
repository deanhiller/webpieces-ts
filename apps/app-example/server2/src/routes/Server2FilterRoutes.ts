import { Routes, RouteBuilder, FilterDefinition } from '@webpieces/http-routing';
import { ContextFilter, LogApiFilter, RecordingFilter } from '@webpieces/http-server';

/**
 * Server2FilterRoutes - server2's filter chain.
 *
 * Priority order (higher runs first):
 * - 2000 ContextFilter: transfers inbound headers (incl. the correlation id and
 *   the chained x-previous-request-id from client-server) into RequestContext,
 *   generates this hop's own fresh x-request-id
 * - 1850 RecordingFilter: test-case recording (x-webpieces-recording header
 *   transfers across hops, so a recorded client-server request records here too)
 * - 1800 LogApiFilter: structured logging keyed by MDC keys (correlationId,
 *   requestId, previousId, tenantId) with secured-header masking
 *
 * No auth filter: Server2Api is @Authentication(false) (internal service).
 */
export class Server2FilterRoutes implements Routes {
    configure(routeBuilder: RouteBuilder): void {
        routeBuilder.addFilter(new FilterDefinition(2000, ContextFilter, '*'));
        routeBuilder.addFilter(new FilterDefinition(1850, RecordingFilter, '*'));
        routeBuilder.addFilter(new FilterDefinition(1800, LogApiFilter, '*'));
    }
}
