import {
    ApiPath,
    ApiType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WpAuthApiKey,
    WpMcpAuthJwt,
    WpMcpTool,
} from '@webpieces/core-util';

/**
 * Both credentials of the `partner` regime, written ONCE and named per method.
 *
 * A real regime authenticates a PAIR, and every method here requires the same pair — so the list is
 * a constant rather than three copies somebody has to keep in step. The extractor follows the name to
 * this literal, which is why declaring it once costs the published document nothing.
 */
const PARTNER_CREDENTIALS = [
    { in: 'header', name: 'x-api-key', description: 'Your partner key.' },
    {
        in: 'header',
        name: 'x-organization-id',
        description: 'The organization the key acts for.',
    },
] as const;

/** The states an order moves through. A named literal union becomes one published enum. */
export type OrderState = 'placed' | 'accepted' | 'delivered' | 'cancelled';

/** A delivery window given as a clock time. */
export interface ScheduledWindow {
    /** Discriminates this branch of {@link DeliveryWindow}. */
    kind: 'scheduled';

    /**
     * When the window opens.
     * @format date-time
     */
    from: string;
}

/** A delivery that goes out as soon as it is ready. */
export interface AsapWindow {
    /** Discriminates this branch of {@link DeliveryWindow}. */
    kind: 'asap';

    /** Roughly how long the kitchen said it needs, in minutes. */
    estimateMinutes: number;
}

/**
 * When the order is meant to arrive.
 *
 * A DISCRIMINATED union: every branch carries `kind` as one string literal, so the published
 * document can narrow it exactly as TypeScript does. A union TypeScript itself could not narrow
 * would be published without a discriminator rather than with an invented one.
 */
export type DeliveryWindow = ScheduledWindow | AsapWindow;

/** One order. */
export interface Order {
    /** Our identifier for it. Stable for the life of the order. */
    id: string;

    /** Where it is in its lifecycle. */
    state: OrderState;

    /**
     * Your own identifier, echoed back. PRESENT and possibly null — an order placed through our own
     * UI has none, which is a different wire document from one where you did not send the field.
     */
    externalId: string | null;

    /** When it was placed. @format date-time */
    placedAt: string;

    /** When it is meant to arrive. */
    window: DeliveryWindow;

    /** Free-form labels you attached at placement. */
    labels: Record<string, string>;
}

export interface FetchOrdersRequest {
    /** The store to read. */
    storeId: string;

    /**
     * Window start, inclusive. Omit for the last 24 hours — OPTIONAL, so it may be absent entirely.
     * @format date-time
     */
    from?: string;

    /** Only these states. Omit for every state. */
    states?: OrderState[];
}

export interface FetchOrdersResponse {
    /** The matching orders, newest first. */
    orders: Order[];

    /** Pass as `from` on the next call; absent when the window is exhausted. */
    nextFrom?: string;
}

export interface CancelOrderRequest {
    /** The order to cancel. */
    orderId: string;

    /** Why, for the store's records. */
    reason: string;
}

export interface CancelOrderResponse {
    /** The order's state after the attempt. */
    state: OrderState;
}

export interface ReindexRequest {
    /** The store whose cache to rebuild. */
    storeId: string;
}

export interface ReindexResponse {
    /** How many menu items were re-read. */
    itemsRead: number;
}

/**
 * Orders placed at a store.
 *
 * Every endpoint here authenticates with the `partner` api-key regime, which requires BOTH the key
 * and the organization it acts for. The published document derives its `securitySchemes` and its
 * single AND-ed `security` requirement from that declaration, so this contract and the document
 * cannot disagree about which headers are needed.
 */
@ApiPath('/orders')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export abstract class PartnerOrdersApi {
    /**
     * Returns every order placed at one store inside a time window, newest first.
     *
     * Paginate by passing the previous response's `nextFrom` until it is absent.
     *
     * @mcp Read-only. Call this before answering any question about recent orders; do not reuse an
     *      earlier answer, order state changes minute to minute.
     */
    @Endpoint(POST, '/fetch', READ, RPC)
    @WpAuthApiKey('partner', PARTNER_CREDENTIALS)
    @WpMcpTool('fetch_orders')
    @WpMcpAuthJwt({ roles: ['partner-agent'] })
    fetchOrders(request: FetchOrdersRequest): Promise<FetchOrdersResponse> {
        throw new Error('Method fetchOrders() must be implemented by subclass');
    }

    /**
     * Cancels one order, if the store has not already started it.
     *
     * Cancelling an order that is already `delivered` returns its current state rather than failing:
     * the call is about reaching a state, not about performing an action exactly once.
     */
    @Endpoint(POST, '/cancel', WRITE, RPC)
    @WpAuthApiKey('partner', PARTNER_CREDENTIALS)
    cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResponse> {
        throw new Error('Method cancelOrder() must be implemented by subclass');
    }

    /**
     * Rebuilds a store's menu cache from the source of truth.
     *
     * Not published: this is an operator tool, and the partner contract has no concept of our cache.
     * It is still served and still demands the `partner` credential — `hidden` is a documentation
     * decision and authorizes nobody.
     */
    @Endpoint(POST, '/reindex', WRITE, RPC, { hidden: true })
    @WpAuthApiKey('partner', PARTNER_CREDENTIALS)
    reindex(request: ReindexRequest): Promise<ReindexResponse> {
        throw new Error('Method reindex() must be implemented by subclass');
    }
}
