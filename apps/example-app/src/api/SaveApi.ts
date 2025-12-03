import { ApiInterface, Post, Path, ValidateImplementation } from '@webpieces/http-routing';
import { JsonObject, JsonProperty } from 'typescript-json-serializer';

/**
 * DI token for SaveApi.
 * Used to register and resolve the SaveApi implementation in the DI container.
 */
export const SaveApiToken = Symbol.for('SaveApi');

// ============================================================
// Request DTOs
// ============================================================

/**
 * Individual item in the save request.
 * Demonstrates nested object serialization.
 */
@JsonObject()
export class SaveItem {
    @JsonProperty()
    id: number = 0;

    @JsonProperty()
    name: string = '';

    @JsonProperty()
    quantity: number = 0;
}

/**
 * Optional metadata for the request.
 */
@JsonObject()
export class RequestMeta {
    @JsonProperty()
    source: string = '';

    @JsonProperty()
    priority: number = 0;
}

/**
 * Save request DTO.
 * Demonstrates array serialization with @JsonProperty.
 */
@JsonObject()
export class SaveRequest {
    @JsonProperty()
    query: string = '';

    @JsonProperty({ type: SaveItem })
    items: SaveItem[] = [];

    @JsonProperty({ type: RequestMeta })
    meta?: RequestMeta;
}

// ============================================================
// Response DTOs
// ============================================================

/**
 * Match result DTO.
 * Similar to Java TheMatch class.
 */
@JsonObject()
export class TheMatch {
    @JsonProperty()
    title: string = '';

    @JsonProperty()
    description: string = '';

    @JsonProperty()
    score: number = 0;
}

/**
 * Processed item in the response.
 * Demonstrates array response serialization.
 */
@JsonObject()
export class ResponseItem {
    @JsonProperty()
    id: number = 0;

    @JsonProperty()
    name: string = '';

    @JsonProperty()
    processed: boolean = false;

    @JsonProperty()
    message: string = '';
}

/**
 * Save response DTO.
 * Similar to Java SaveResponse class.
 */
@JsonObject()
export class SaveResponse {
    @JsonProperty()
    query: string = '';

    @JsonProperty()
    searchTime: number = 0;

    @JsonProperty()
    success: boolean = false;

    @JsonProperty({ type: TheMatch })
    matches: TheMatch[] = [];

    @JsonProperty({ type: ResponseItem })
    processedItems: ResponseItem[] = [];
}

// ============================================================
// API Interface & Prototype
// ============================================================

/**
 * SaveApi - Pure interface defining the API contract.
 *
 * This is the type-safe contract that both server and client must follow.
 * Controllers implement this interface to ensure they provide all required methods.
 */
export interface SaveApi {
    save(request: SaveRequest): Promise<SaveResponse>;
}

/**
 * SaveApiPrototype - Abstract class with routing decorators.
 *
 * This class serves as the single source of truth for routing metadata:
 * 1. Server-side: RESTApiRoutes reads decorators to bind routes to controllers
 * 2. Client-side: Client generator reads decorators to create HTTP client proxies
 *
 * Pattern:
 * ```typescript
 * // 1. Define interface (contract)
 * interface SaveApi { ... }
 *
 * // 2. Define prototype with decorators (metadata)
 * abstract class SaveApiPrototype { ... }
 *
 * // 3. Controller extends prototype AND implements interface
 * class SaveController extends SaveApiPrototype implements SaveApi {
 *   // MUST override all methods from SaveApi
 *   // TypeScript will error if any are missing
 * }
 * ```
 *
 * Benefits:
 * - Decorators live on the prototype, not the implementation
 * - Interface enforces that all methods are implemented
 * - Same metadata used for server routing and client generation
 * - Compile error if controller doesn't implement a method
 * - Type-safe contract between client and server
 *
 * Note: Methods throw by default to catch runtime errors if not overridden.
 */
@ApiInterface()
export abstract class SaveApiPrototype implements SaveApi {
    @Post()
    @Path('/search/item')
    save(request: SaveRequest): Promise<SaveResponse> {
        throw new Error('Method save() must be implemented by subclass');
    }
}
