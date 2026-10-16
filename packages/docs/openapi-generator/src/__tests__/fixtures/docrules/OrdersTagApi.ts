/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, READ, RPC, WpAuthorization, WpAuthPublic } from '@webpieces/core-util';

/** Which order to read. */
export class ReadOrderRequest {
    /** The order's identifier. */
    orderId!: string;
}

/** One order. */
export class ReadOrderResponse {
    /** Its state. */
    state!: string;
}

/** OWNER PROSE: the Orders section intro, from the API contract. */
@ApiPath('/orders')
export class OrdersTagApi {
    /**
     * Reads one order.
     *
     * @returns The order.
     */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    read(request: ReadOrderRequest): Promise<ReadOrderResponse> {
        throw new Error('contract');
    }
}
