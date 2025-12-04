import { ApiInterface, Post, Path, ValidateImplementation } from '@webpieces/http-routing';

// ============================================================
// Request DTOs
// All fields are optional for protocol evolution/future-proofing
// ============================================================

/**
 * Nested sub-item for testing deep object serialization.
 */
export interface SubItem {
    thename?: string;
    count?: number;
}

/**
 * Individual item in the save request.
 * Demonstrates nested object serialization.
 */
export interface SaveItem {
    id?: number;
    name?: string;
    quantity?: number;
    subItem?: SubItem;
}

/**
 * Optional metadata for the request.
 */
export interface RequestMeta {
    source?: string;
    priority?: number;
}

/**
 * Save request DTO.
 * All fields optional for protocol evolution.
 */
export interface SaveRequest {
    query?: string;
    items?: SaveItem[];
    meta?: RequestMeta;
    createdAt?: string; // ISO-8601 string (use InstantDto if you need Date methods)
}

// ============================================================
// Response DTOs
// All fields are optional for protocol evolution/future-proofing
// ============================================================

/**
 * Match result DTO.
 * Similar to Java TheMatch class.
 */
export interface TheMatch {
    title?: string;
    description?: string;
    score?: number;
}

/**
 * Processed item in the response.
 * Demonstrates array response serialization.
 */
export interface ResponseItem {
    id?: number;
    name?: string;
    processed?: boolean;
    message?: string;
    subItemResult?: SubItem;
}

/**
 * Save response DTO.
 * Similar to Java SaveResponse class.
 */
export interface SaveResponse {
    query?: string;
    searchTime?: number;
    success?: boolean;
    matches?: TheMatch[];
    processedItems?: ResponseItem[];
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
