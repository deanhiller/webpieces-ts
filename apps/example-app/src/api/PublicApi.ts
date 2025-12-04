import { ApiInterface, Get, Path, ValidateImplementation } from '@webpieces/http-routing';

// ============================================================
// Request DTOs
// ============================================================

/**
 * Request to get public info.
 */
export interface PublicInfoRequest {
    name?: string;
}

// ============================================================
// Response DTOs
// ============================================================

/**
 * Response with public info.
 */
export interface PublicInfoResponse {
    greeting?: string;
    serverTime?: string; // ISO-8601 string (use InstantDto if you need Date methods)
    name?: string;
}

// ============================================================
// API Interface & Prototype
// ============================================================

/**
 * PublicApi - Pure interface defining the API contract.
 *
 * A simple public API that doesn't require authentication.
 * Used to demonstrate a second API endpoint for testing.
 */
export interface PublicApi {
    getInfo(request: PublicInfoRequest): Promise<PublicInfoResponse>;
}

/**
 * PublicApiPrototype - Abstract class with routing decorators.
 *
 * Defines the route metadata for the public API endpoints.
 */
@ApiInterface()
export abstract class PublicApiPrototype implements PublicApi {
    @Get()
    @Path('/public/info')
    getInfo(request: PublicInfoRequest): Promise<PublicInfoResponse> {
        throw new Error('Method getInfo() must be implemented by subclass');
    }
}
