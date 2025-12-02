import { RouteRequest } from '@webpieces/http-routing';
import { RouteMetadata } from '@webpieces/http-api';

/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request information.
 *
 * MethodMeta is created by WebpiecesServerImpl when handling a request:
 * - routeMeta: Static route information (httpMethod, path, methodName)
 * - routeRequest: Express Request/Response objects
 * - requestDto: Set by JsonFilter after deserializing the request body
 */
export class MethodMeta {
    /**
     * Route metadata (httpMethod, path, methodName, parameterTypes)
     */
    routeMeta: RouteMetadata;

    /**
     * Express Request and Response objects
     */
    routeRequest: RouteRequest;

    /**
     * The deserialized request DTO.
     * Set by JsonFilter after deserializing the request body.
     */
    requestDto?: unknown;

    /**
     * Additional metadata for storing request-scoped data.
     */
    metadata: Map<string, unknown>;

    constructor(
        routeMeta: RouteMetadata,
        routeRequest: RouteRequest,
        requestDto?: unknown,
        metadata?: Map<string, unknown>,
    ) {
        this.routeMeta = routeMeta;
        this.routeRequest = routeRequest;
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
