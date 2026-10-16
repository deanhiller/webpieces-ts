/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, READ, RPC, WpAuthorization, WpAuthPublic } from '@webpieces/core-util';
import { ReadOrderRequest, ReadOrderResponse } from './OrdersTagApi';

/** SECOND OWNER PROSE: a second API contract filed under the same tag. */
@ApiPath('/orders-again')
export class SecondOrdersTagApi {
    /**
     * Reads one order again.
     *
     * @summary Read an order again
     * @returns The order.
     */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    readAgain(request: ReadOrderRequest): Promise<ReadOrderResponse> {
        throw new Error('contract');
    }
}
