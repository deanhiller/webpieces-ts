import { RouteMetadata } from '@webpieces/http-api';

/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request information.
 *
 * MethodMeta is DTO-only - it does NOT contain Express req/res directly.
 *
 * Fields:
 * - routeMeta: Static route information (httpMethod, path, methodName)
 * - requestHeaders: HTTP headers from the request (NEW)
 * - requestDto: The deserialized request body
 * - metadata: Request-scoped data for filters to communicate
 */
export class MethodMeta {
    /**
     * Route metadata (httpMethod, path, methodName, parameterTypes)
     */
    routeMeta: RouteMetadata;

    /**
     * HTTP headers from the request.
     * Map of header name (lowercase) -> array of values.
     *
     * HTTP spec allows multiple values for same header name,
     * so we store as string[] (even though most headers have single value).
     *
     * LIFECYCLE:
     * 1. Set by ExpressWrapper BEFORE filter chain executes
     * 2. ContextFilter (priority 2000) transfers headers to RequestContext
     * 3. ContextFilter CLEARS this field (sets to undefined) after transfer
     * 4. ALL FILTERS AFTER ContextFilter will see this as UNDEFINED
     *
     * IMPORTANT: Downstream filters should NOT read from requestHeaders!
     * Instead, use RequestContext.getHeader() to read headers after ContextFilter.
     *
     * Example (correct usage in downstream filters):
     * ```typescript
     * const requestId = RequestContext.getHeader(WebpiecesCoreHeaders.REQUEST_ID);
     * ```
     */
    public requestHeaders?: Map<string, string[]>;

    /**
     * The deserialized request DTO.
     */
    requestDto?: unknown;

    /**
     * Additional metadata for storing request-scoped data.
     * Used by filters to pass data to other filters/controllers.
     */
    metadata: Map<string, unknown>;

    constructor(
        routeMeta: RouteMetadata,
        requestHeaders?: Map<string, string[]>,
        requestDto?: unknown,
        metadata?: Map<string, unknown>,
    ) {
        this.routeMeta = routeMeta;
        this.requestHeaders = requestHeaders;
        this.requestDto = requestDto;
        this.metadata = metadata ?? new Map();
    }

    /**
     * Get the HTTP method (convenience accessor).
     */
    get httpMethod(): string {
        return this.routeMeta.httpMethod;
    }

    /**
     * Get the request path (convenience accessor).
     */
    get path(): string {
        return this.routeMeta.path;
    }

    /**
     * Get the method name (convenience accessor).
     */
    get methodName(): string {
        return this.routeMeta.methodName;
    }
}
