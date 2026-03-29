import { ApiPath, Endpoint, Authentication, AuthenticationConfig } from '@webpieces/http-api';

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
// API Definition
// ============================================================

/**
 * SaveApi - Abstract class defining the API contract with routing decorators.
 *
 * This class is the single source of truth for both the contract and routing metadata:
 * 1. Server-side: ApiRoutingFactory reads decorators to bind routes to controllers
 * 2. Client-side: createApiClient reads decorators to create HTTP client proxies
 * 3. Controllers implement this class to get compile-time enforcement
 *
 * Using abstract methods means TypeScript enforces implementation at compile time.
 */
@Authentication(new AuthenticationConfig(true))
@ApiPath('/search')
export abstract class SaveApi {
    @Endpoint('/item')
    save(request: SaveRequest): Promise<SaveResponse> {
        throw new Error('Method save() must be implemented by subclass');
    }
}
