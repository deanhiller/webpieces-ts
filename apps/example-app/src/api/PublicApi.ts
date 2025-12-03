import { ApiInterface, Get, Path, ValidateImplementation } from '@webpieces/http-routing';
import { JsonObject, JsonProperty } from 'typescript-json-serializer';

/**
 * DI token for PublicApi.
 * Used to register and resolve the PublicApi implementation in the DI container.
 */
export const PublicApiToken = Symbol.for('PublicApi');

// ============================================================
// Request DTOs
// ============================================================

/**
 * Request to get public info.
 */
@JsonObject()
export class PublicInfoRequest {
    @JsonProperty() name?: string;
}

// ============================================================
// Response DTOs
// ============================================================

/**
 * Response with public info.
 */
@JsonObject()
export class PublicInfoResponse {
    @JsonProperty() greeting?: string;
    @JsonProperty() serverTime?: string;
    @JsonProperty() name?: string;
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
