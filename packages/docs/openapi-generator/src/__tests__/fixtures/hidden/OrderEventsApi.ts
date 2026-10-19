/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
    WRITE,
} from '@webpieces/core-util';

/** Sent when an order ships. */
export interface OrderShippedEvent {
    /** The order that shipped. */
    orderId: string;

    /**
     * The carrier's internal tracking code.
     * @hidden SECRET-REASON-tracking partners get tracking with the tracking launch
     */
    trackingCode?: string;
}

/** Order events this service SENDS. */
@ApiPath('/hooks')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class OrderEventsApi {
    /**
     * Sent whenever an order ships.
     *
     * @summary Order shipped
     */
    @Endpoint(POST, '/order.shipped', WRITE, RPC)
    @WpAuthPublic('Never served here; this declares a payload we SEND to a partner endpoint.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here; this declares a payload we SEND to a partner endpoint.' })
    orderShipped(event: OrderShippedEvent): Promise<void> {
        throw new Error('contract');
    }
}
