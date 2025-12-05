import { RouteMetadata } from '@webpieces/http-api';
import { RouterReqResp } from './RouterReqResp';

/**
 * Metadata about the method being invoked.
 * Passed to filters and contains request/response information.
 *
 * NEW: MethodMeta now includes RouterReqResp (Express-independent abstraction).
 * This allows filters to access request/response without depending on Express.
 *
 * Fields:
 * - routeMeta: Static route information (httpMethod, path, methodName)
 * - routerReqResp: Request/response abstraction (NEW)
 * - requestDto: The deserialized request body (set by JsonFilter)
 * - metadata: Request-scoped data for filters to communicate
 */
export class MethodMeta {
    /**
     * Route metadata (httpMethod, path, methodName, parameterTypes)
     */
    routeMeta: RouteMetadata;

    /**
     * Router request/response abstraction (Express-independent).
     * Allows filters to read headers, body, and write responses
     * without depending on Express directly.
     */
    routerReqResp: RouterReqResp;

    /**
     * The deserialized request DTO.
     * Set by JsonFilter after parsing the JSON body.
     */
    requestDto?: unknown;

    /**
     * Additional metadata for storing request-scoped data.
     * Used by filters to pass data to other filters/controllers.
     */
    metadata: Map<string, unknown>;

    constructor(
        routeMeta: RouteMetadata,
        routerReqResp?: RouterReqResp,
        requestDto?: unknown,
        metadata?: Map<string, unknown>,
    ) {
        this.routeMeta = routeMeta;
        this.routerReqResp = routerReqResp;
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
