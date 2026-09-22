/* eslint-disable */
/**
 * A contract that declares NO `@ApiType`.
 *
 * It must feed the internal document ALONE. That is the fail-closed default the whole selection
 * design rests on: a contract whose author typed nothing about who reads it reaches nobody but us.
 */
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic } from '@webpieces/core-util';

export interface Ping {
    echo: string;
}

@ApiPath('/api/no-api-type')
export class NoApiTypeApi {
    /** Says nothing about who may read it, so the default decides. */
    @Endpoint(POST, '/ping', READ, RPC)
    @WpAuthPublic('Fixture only.')
    ping(request: Ping): Promise<void> {
        throw new Error('contract');
    }
}
