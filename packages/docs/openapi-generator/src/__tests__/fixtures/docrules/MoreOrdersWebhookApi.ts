/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, RPC, WpAuthorization, WpAuthPublic, WRITE } from '@webpieces/core-util';
import { OrderShippedEvent } from './OrdersWebhookApi';

/** SECOND WEBHOOK PROSE: more events about orders. */
@ApiPath('/more-order-hooks')
export class MoreOrdersWebhookApi {
    /**
     * Sent when an order is delivered.
     *
     * @summary Order delivered
     */
    @Endpoint(POST, '/order.delivered', WRITE, RPC)
    @WpAuthPublic('Never served here.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here.' })
    orderDelivered(event: OrderShippedEvent): Promise<void> {
        throw new Error('contract');
    }
}
