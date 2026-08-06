import { ApiPath, Endpoint, Public } from '@webpieces/core-util';

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
// API Definition
// ============================================================

/**
 * PublicApi - Abstract class defining the API contract with routing decorators.
 *
 * A simple public API that doesn't require authentication.
 * Used to demonstrate a second API endpoint for testing.
 */
@Public()
@ApiPath('/public')
export abstract class PublicApi {
    @Endpoint('/info', 'rpc')
    getInfo(request: PublicInfoRequest): Promise<PublicInfoResponse> {
        throw new Error('Method getInfo() must be implemented by subclass');
    }
}
