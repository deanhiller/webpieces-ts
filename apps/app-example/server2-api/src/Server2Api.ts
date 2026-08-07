import { ApiPath, AuthSharedSecret, Endpoint } from '@webpieces/core-util';

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
 * 2. Client-side (client-server): ClientHttpFactory turns it into an HTTP client
 *    whose ContextMgr transfers the magic context (request-id chain,
 *    correlation id, tenant, ...) as headers
 * 3. Tests: rebind to a mock/simulator - no HTTP at all
 *
 * AUTHENTICATES ITS CALLER, and that is the point of the example rather than a detail: server2 is an
 * INTERNAL service, so it proves WHO is calling before it believes anything that caller forwarded.
 * That is what admits the magic context's TRUSTED keys (userId, orgId, roles — see the trust section
 * of ContextKey) on this hop. A `@Public()` endpoint cannot verify its caller, so a trusted key
 * arriving there is rejected outright by AuthFilter — which is correct, and is why "public endpoint
 * on an internal service that receives forwarded identity" is not a shape this example should teach.
 */
@AuthSharedSecret('INTERNAL_API_SECRET')
@ApiPath('/server2')
export abstract class Server2Api {
    @Endpoint('/fetchValue', 'rpc')
    fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        throw new Error('Method fetchValue() must be implemented by subclass');
    }
}
