/* eslint-disable */
/**
 * A document that MIXES a credentialled route with an uncredentialled one.
 *
 * This is the shape that decides between hoisting the security requirement to the document and
 * stamping it per operation: hoisting here would tell a customer that the public endpoint needs a key.
 */
import {
    ApiPath,
    ApiType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthApiKey,
    WpAuthPublic,
} from '@webpieces/core-util';

export interface PingRequest {
    echo: string;
}

export interface PingResponse {
    echo: string;
}

export interface SecretRequest {
    id: string;
}

export interface SecretResponse {
    value: string;
}

/** A contract with one open door and one locked one. */
@ApiPath('/mixed')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class MixedApi {
    /** Anyone may call this. */
    @Endpoint(POST, '/ping', READ, RPC)
    @WpAuthPublic('A liveness probe; there is nothing here to protect.')
    ping(request: PingRequest): Promise<PingResponse> {
        throw new Error('contract');
    }

    /** Only a partner may call this. */
    @Endpoint(POST, '/secret', READ, RPC)
    @WpAuthApiKey('partner', [{ in: 'header', name: 'x-api-key', description: 'Your key.' }])
    secret(request: SecretRequest): Promise<SecretResponse> {
        throw new Error('contract');
    }
}
