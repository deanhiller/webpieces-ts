/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
    WpMcpTool,
} from '@webpieces/core-util';

/** How a request pages. A base the request flattens in. */
export class PageDto {
    /** How many orders per page. */
    limit?: number;

    /**
     * An opaque paging cursor.
     * @hidden SECRET-REASON-cursor paging is not announced yet
     */
    cursor?: string;
}

/** Who carries an order. Reached ONLY through a hidden field, so the customer never sees it. */
export class CourierDto {
    /** The courier's name. */
    name!: string;
}

/** One order. Every operation that returns orders reaches it, so it is a component. */
export class OrderDto {
    /** The order's identifier. */
    orderId!: string;

    /**
     * Estimated delivery time, ISO-8601.
     * @hidden SECRET-REASON-eta ships with the delivery-ETA launch
     * @format date-time
     */
    deliveryEta?: string;

    /**
     * Who carries it.
     * @hidden
     */
    courier?: CourierDto;
}

/** Which orders to fetch. */
export class FetchOrdersRequest extends PageDto {
    /** The store whose orders to fetch. */
    storeId!: string;

    /**
     * Only orders placed after this time.
     * @hidden SECRET-REASON-since the filter is still being load-tested
     */
    since?: string;
}

/** The orders asked for. */
export class FetchOrdersResponse {
    /** The orders, newest first. */
    orders!: OrderDto[];
}

/** Which order to read. */
export class GetOrderRequest {
    /** The order's identifier. */
    orderId!: string;
}

/** Orders (#1246). */
@ApiPath('/orders')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class OrdersApi {
    /**
     * Lists a store's orders.
     *
     * @summary Fetch orders
     * @returns The orders asked for.
     */
    @Endpoint(POST, '/fetch', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('fetch_orders')
    fetchOrders(request: FetchOrdersRequest): Promise<FetchOrdersResponse> {
        throw new Error('contract');
    }

    /**
     * Reads one order.
     *
     * @summary Get an order
     * @returns The order asked for.
     */
    @Endpoint(POST, '/get', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('get_order')
    getOrder(request: GetOrderRequest): Promise<OrderDto> {
        throw new Error('contract');
    }
}
