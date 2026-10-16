/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, RPC, WpAuthorization, WpAuthPublic, WRITE } from '@webpieces/core-util';

/** The event a partner receives when an order ships. */
export class OrderShippedEvent {
    /** The order that shipped. */
    orderId!: string;
}

/** FIRST WEBHOOK PROSE: the events we send about orders. */
@ApiPath('/order-hooks')
export class OrdersWebhookApi {
    /** Sent when an order ships. */
    @Endpoint(POST, '/order.shipped', WRITE, RPC)
    @WpAuthPublic('Never served here.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here.' })
    orderShipped(event: OrderShippedEvent): Promise<void> {
        throw new Error('contract');
    }
}
