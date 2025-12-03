import { RouteMetadata } from '@webpieces/http-api';

/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request information.
 *
 * MethodMeta is DTO-only - it does NOT contain Express req/res.
 * Express objects are handled by the Express layer (wrapExpress, jsonTranslator).
 *
 * Fields:
 * - routeMeta: Static route information (httpMethod, path, methodName)
 * - requestDto: The deserialized request body
 * - metadata: Request-scoped data for filters to communicate
 */
export class MethodMeta {
    /**
     * Route metadata (httpMethod, path, methodName, parameterTypes)
     */
    routeMeta: RouteMetadata;

    /**
     * The deserialized request DTO.
     */
    requestDto?: unknown;

    /**
     * Additional metadata for storing request-scoped data.
     * Used by filters to pass data to other filters/controllers.
     */
    metadata: Map<string, unknown>;

    constructor(routeMeta: RouteMetadata, requestDto?: unknown, metadata?: Map<string, unknown>) {
        this.routeMeta = routeMeta;
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
