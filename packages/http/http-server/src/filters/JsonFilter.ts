import { injectable, inject } from 'inversify';
import { provideSingleton } from '@webpieces/http-routing';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';
import { toError } from '@webpieces/core-util';
import { Request, Response } from 'express';
import { JsonSerializer } from 'typescript-json-serializer';
import { MethodMeta } from '../MethodMeta';

/**
 * DI tokens for JsonFilter.
 */
export const FILTER_TYPES = {
    JsonFilterConfig: Symbol.for('JsonFilterConfig'),
};

/**
 * Configuration for JsonFilter.
 * Register this in your DI container to customize JsonFilter behavior.
 */
@injectable()
export class JsonFilterConfig {
    // Configuration options can be added here
}

/**
 * JsonFilter - Handles JSON serialization/deserialization and writes response to HTTP body.
 *
 * Similar to Java WebPieces JacksonCatchAllFilter.
 *
 * Flow:
 * 1. Log request
 * 2. Deserialize request body to DTO and set on meta.requestDto
 * 3. Call next filter/controller
 * 4. Get response (WpResponse)
 * 5. Write response to Express response
 * 6. On ANY exception, send 500
 */
@provideSingleton()
@injectable()
export class JsonFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    private serializer: JsonSerializer;

    constructor(@inject(FILTER_TYPES.JsonFilterConfig) private config: JsonFilterConfig) {
        super();
        this.serializer = new JsonSerializer();
    }

    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // Get Express Request/Response from routeRequest
        const expressRequest = meta.routeRequest.request as Request;
        const expressResponse = meta.routeRequest.response as Response;

        try {
            // 1. Log request
            this.logRequest(meta, expressRequest);

            // 2. Deserialize request body to DTO
            this.deserializeRequest(meta, expressRequest);

            // 3. Call next filter/controller
            const responseWrapper = await nextFilter.invoke(meta);

            // 4. Log response
            this.logResponse(responseWrapper);

            // 5. Write response to Express response
            this.writeResponse(expressResponse, responseWrapper);

            return responseWrapper;
        } catch (err: unknown) {
            const error = toError(err);
            // 6. On ANY exception, send 500
            console.error('[JsonFilter] Error:', error);
            const errorResponse = new WpResponse({ error: 'Internal server error' }, 500);
            this.writeResponse(expressResponse, errorResponse);
            return errorResponse;
        }
    }

    /**
     * Deserialize request body to DTO and set on meta.requestDto.
     * Uses JsonSerializer from typescript-json-serializer to properly
     * deserialize nested objects and arrays with @JsonObject/@JsonProperty.
     */
    private deserializeRequest(meta: MethodMeta, expressRequest: Request): void {
        if(!expressRequest.body) {
            throw new Error("missing body for request dto");
        }
            // Get the parameter type from route metadata (first parameter is the request DTO)
            const parameterTypes = meta.routeMeta.parameterTypes;
        if(!parameterTypes)
            throw new Error("missing parameterTypes");
        else if(parameterTypes.length === 0)
            throw new Error("parameterType length is 0 and must be more");
        const dtoClass = parameterTypes[0];
        // EXPERIMENT: Just use the raw body (already parsed by express.json())
        // instead of JsonSerializer to see if we really need it
        meta.requestDto = expressRequest.body;
        console.log('[JsonFilter] Using raw body (no JsonSerializer), dtoClass was:', dtoClass?.name);
    }

    /**
     * Write WpResponse to HTTP response body as JSON.
     */
    private writeResponse(expressResponse: Response, responseWrapper: WpResponse<unknown>): void {
        // Set status code
        expressResponse.status(200);

        // Set content type to JSON
        expressResponse.setHeader('Content-Type', 'application/json');

        // Serialize and write response body
        if (responseWrapper.response !== undefined) {
            expressResponse.json(responseWrapper.response);
        } else {
            expressResponse.end();
        }
    }

    /**
     * Log the incoming request.
     */
    private logRequest(meta: MethodMeta, expressRequest: Request): void {
        console.log(`[JsonFilter] ${meta.httpMethod} ${meta.path}`);
        if (expressRequest.body) {
            console.log('[JsonFilter] Request body:', JSON.stringify(expressRequest.body, null, 2));
        }
    }

    /**
     * Log the outgoing response.
     */
    private logResponse(responseWrapper: WpResponse<unknown>): void {
        if (responseWrapper.response) {
            console.log(
                '[JsonFilter] Response body:',
                JSON.stringify(responseWrapper.response, null, 2),
            );
        }
    }
}

/**
 * Exception thrown when validation fails.
 */
export class ValidationException extends Error {
    constructor(public violations: string[]) {
        super('Validation failed');
        this.name = 'ValidationException';
    }
}

/**
 * HTTP exception with status code.
 */
export class HttpException extends Error {
    constructor(
        message: string,
        public statusCode: number,
    ) {
        super(message);
        this.name = 'HttpException';
    }
}
