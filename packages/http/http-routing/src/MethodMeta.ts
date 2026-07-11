import { RouteMetadata } from '@webpieces/core-util';

/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request information.
 *
 * MethodMeta is DTO-only - it does NOT contain Express req/res, nor the raw headers. The raw
 * inbound request (headers/method/path) lives on the transport-neutral {@link HttpRequest} in
 * RequestContext (read via `RequestContext.getRequest()`); MethodMeta carries only the typed
 * body + route/auth metadata that flow as the chain's call argument.
 *
 * It is the meta type every `Filter<MethodMeta, …>` is parameterized over. It lives in
 * @webpieces/http-routing and is express-free, so filter authors reference it without pulling
 * in any express dependency.
 *
 * Fields:
 * - routeMeta: Static route information (httpMethod, path, methodName, authMeta)
 * - requestDto: The deserialized request body
 * - metadata: Request-scoped data for filters to communicate
 *
 * Auth mode lives on {@link RouteMetadata.authMeta} (the one source of truth for fixed route
 * metadata); read it via `methodMeta.routeMeta.authMeta`. MethodMeta itself carries only the
 * static route reference + the request-scoped body/bag.
 */
export class MethodMeta {
    /**
     * Route metadata (httpMethod, path, methodName, parameterTypes)
     */
    routeMeta: RouteMetadata;

    /**
     * The deserialized request DTO.
     */
    // webpieces-disable no-any-unknown -- request DTO type is erased at the filter boundary
    requestDto?: unknown;

    /**
     * Additional metadata for storing request-scoped data.
     * Used by filters to pass data to other filters/controllers.
     */
    // webpieces-disable no-any-unknown -- request-scoped bag holds heterogeneous filter data
    metadata: Map<string, unknown>;

    constructor(
        routeMeta: RouteMetadata,
        // webpieces-disable no-any-unknown -- request DTO type is erased at the filter boundary
        requestDto?: unknown,
        // webpieces-disable no-any-unknown -- request-scoped bag holds heterogeneous filter data
        metadata?: Map<string, unknown>,
    ) {
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
