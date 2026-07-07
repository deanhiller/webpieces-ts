import { ApiPath, Endpoint, Authentication, AuthenticationConfig } from '@webpieces/core-util';

/**
 * Request to server2.
 * All fields optional for protocol evolution.
 */
export interface FetchValueRequest {
    name?: string;
}

/**
 * Response from server2.
 * All fields optional for protocol evolution.
 */
export interface FetchValueResponse {
    value?: string;
    timestamp?: number;
}

/**
 * Server2Api - Abstract class defining server2's contract with routing
 * decorators (same pattern as SaveApi/PublicApi).
 *
 * This makes the client-server -> server2 call a REAL HTTP hop:
 * 1. Server-side (server2): ApiRoutingFactory wires it to Server2Controller
 * 2. Client-side (client-server): createApiClient turns it into an HTTP client
 *    whose ContextMgr transfers the magic context (request-id chain,
 *    correlation id, tenant, ...) as headers
 * 3. Tests: rebind to a mock/simulator - no HTTP at all
 */
@Authentication(new AuthenticationConfig(false))
@ApiPath('/server2')
export abstract class Server2Api {
    @Endpoint('/fetchValue')
    fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        throw new Error('Method fetchValue() must be implemented by subclass');
    }
}
