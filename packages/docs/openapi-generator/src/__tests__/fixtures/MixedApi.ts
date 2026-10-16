import { WpAuthorization, AuthorizationType, WpAuth, apiKey as apiKeyAuth } from '@webpieces/core-util';
/* eslint-disable */
/**
 * A document that MIXES a credentialled route with an uncredentialled one.
 *
 * This is the shape that decides between hoisting the security requirement to the document and
 * stamping it per operation: hoisting here would tell a customer that the public endpoint needs a key.
 */
import { ApiPath, ApiType, Endpoint, EXTERNAL_CUSTOMER, POST, READ, RPC, SVC_TO_SVC, WpAuthPublic } from '@webpieces/core-util';
import { WidgetKeys } from './Headers';

/** What to echo back. */
export interface PingRequest {
    echo: string;
}

/** The echo. */
export interface PingResponse {
    echo: string;
}

/** Which secret to read. */
export interface SecretRequest {
    id: string;
}

/** The secret's value. */
export interface SecretResponse {
    value: string;
}

/** A contract with one open door and one locked one. */
@ApiPath('/mixed')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class MixedApi {
    /**
     * Anyone may call this.
     *
     * @summary Ping the service
     * @returns The request's echo, unchanged.
     */
    @Endpoint(POST, '/ping', READ, RPC)
    @WpAuthPublic('A liveness probe; there is nothing here to protect.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'A liveness probe; there is nothing here to protect.' })
    ping(request: PingRequest): Promise<PingResponse> {
        throw new Error('contract');
    }

    /**
     * Only a partner may call this.
     *
     * @summary Read the partner secret
     * @returns The secret's value.
     */
    @Endpoint(POST, '/secret', READ, RPC)
    @WpAuth([apiKeyAuth('partner', [{ in: 'header', key: WidgetKeys.API_KEY, description: 'Your key.' }])])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    secret(request: SecretRequest): Promise<SecretResponse> {
        throw new Error('contract');
    }
}
