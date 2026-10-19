/* eslint-disable */
import { ApiPath, ApiType, AuthorizationType, Endpoint, EXTERNAL_CUSTOMER, POST, READ, RPC, SVC_TO_SVC, WpAuthorization, WpAuthPublic } from '@webpieces/core-util';

/** One order (#1246). */
export class HiddenOrder {
    /** The order's identifier. */
    orderId!: string;

    /**
     * Estimated delivery time.
     * @hidden ships with the delivery-ETA launch
     * @format date-time
     */
    deliveryEta?: string;

    /**
     * Bare tag, no reason.
     * @hidden
     */
    note?: string;
}

/** Fixture for the field-level `@hidden` tag (#1246). */
@ApiPath('/hidden')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class HiddenFieldApi {
    /**
     * Reads one order.
     * @summary Get an order
     * @returns The order.
     */
    @Endpoint(POST, '/get', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    get(request: HiddenOrder): Promise<HiddenOrder> {
        throw new Error('contract');
    }
}
