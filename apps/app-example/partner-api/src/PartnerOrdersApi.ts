import { WpAuthorization, AuthorizationType, WpAuth, apiKey as apiKeyAuth } from '@webpieces/core-util';
import { ApiPath, ApiType, Endpoint, EXTERNAL_CUSTOMER, MCP, POST, READ, RPC, SVC_TO_SVC, WRITE, WpMcpTool } from '@webpieces/core-util';
import { WindowedStoreRequest } from './OrderRequestBases';
import { PartnerHeaderKeys } from './PartnerHeaderKeys';

export class PartnerAccessPolicy {
    llmRoles!: readonly string[];
}

/**
 * Both credentials of the `partner` regime, written ONCE and named per method.
 *
 * A real regime authenticates a PAIR, and every method here requires the same pair — so the list is
 * a constant rather than three copies somebody has to keep in step. The extractor follows the name to
 * this literal, which is why declaring it once costs the published document nothing.
 */
const PARTNER_CREDENTIALS = [
    { in: 'header', key: PartnerHeaderKeys.API_KEY, description: 'Your partner key.' },
    {
        in: 'header',
        key: PartnerHeaderKeys.ORGANIZATION_ID,
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

// Declared OrderDto, published as Order: the manifest's schemaNames strips the suffix, and every
// JSDoc link to it publishes the stripped name too (#1284).
/** One order. */
export interface OrderDto {
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

// `storeId` is inherited from StoreScopedRequest two levels up, and `from` REDECLARES
// WindowedStoreRequest's field — the golden's inheritance case (#1055). A line comment, so this note
// stays private: only the JSDoc below publishes, as the schema's description.
/**
 * Which orders to fetch: one store's orders inside a time window, optionally narrowed by state.
 *
 * @privateRemarks The golden's inheritance case (#1055): `storeId` comes from StoreScopedRequest two
 * levels up. This sentence must appear in NO generated document — the #1292 stripping proof.
 */
export interface FetchOrdersRequest extends WindowedStoreRequest {
    /**
     * Window start, inclusive. Omit for the last 24 hours — OPTIONAL, so it may be absent entirely.
     * @format date-time
     */
    from?: string;

    /** Only these states. Omit for every state. */
    states?: OrderState[];
}

/** One page of a store's orders, and where the next page starts. */
export interface FetchOrdersResponse {
    /** The matching orders, newest first. */
    orders: OrderDto[];

    /** Pass as `from` on the next call; absent when the window is exhausted. */
    nextFrom?: string;
}

/** The order to cancel, and why. */
export interface CancelOrderRequest {
    /** The order to cancel. */
    orderId: string;

    /** Why, for the store's records. */
    reason: string;
}

/** Where an order stands after a cancellation attempt. */
export interface CancelOrderResponse {
    /** The order's state after the attempt. */
    state: OrderState;
}

/** The store whose menu cache to rebuild. */
export interface ReindexRequest {
    /** The store whose cache to rebuild. */
    storeId: string;
}

/** What a menu-cache rebuild re-read. */
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
     * @summary Fetch your orders
     * @returns The page of matching orders, newest first, with `nextFrom` set while more remain.
     * @privateRemarks Backed by the orders read replica, which lags the primary by up to a second.
     * Internal only: this note must appear in NO generated document (#1292).
     * @mcp Read-only. Call this before answering any question about recent orders; do not reuse an
     *      earlier answer, order state changes minute to minute. Each {@link OrderDto} it returns can
     *      be cancelled with {@link PartnerOrdersApi.cancelOrder}.
     */
    @Endpoint(POST, '/fetch', READ, RPC)
    @WpAuth([apiKeyAuth('partner', PARTNER_CREDENTIALS)])
    @WpAuthorization<PartnerAccessPolicy>({ authType: AuthorizationType.CUSTOM, appPolicy: {llmRoles: ['partner-agent']} })
    @WpMcpTool('fetch_orders')

    fetchOrders(request: FetchOrdersRequest): Promise<FetchOrdersResponse> {
        throw new Error('Method fetchOrders() must be implemented by subclass');
    }

    /**
     * Cancels one order — an {@link OrderDto.id} that {@link PartnerOrdersApi.fetchOrders} returned —
     * if the store has not already started it.
     *
     * Cancelling an order that is already `delivered` returns its current state rather than failing:
     * the call is about reaching a state, not about performing an action exactly once.
     *
     * @summary Cancel an order
     * @returns The order's state after the attempt — `cancelled`, or the state that prevented it.
     */
    @Endpoint(POST, '/cancel', WRITE, RPC)
    @WpAuth([apiKeyAuth('partner', PARTNER_CREDENTIALS)])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResponse> {
        throw new Error('Method cancelOrder() must be implemented by subclass');
    }

    /**
     * Rebuilds a store's menu cache from the source of truth.
     *
     * Not published: this is an operator tool, and the partner contract has no concept of our cache.
     * It is still served and still demands the `partner` credential — `hidden` is a documentation
     * decision and authorizes nobody.
     *
     * @summary Rebuild a store's menu cache
     * @returns How many menu items the rebuild re-read.
     */
    @Endpoint(POST, '/reindex', WRITE, RPC, { hidden: true })
    @WpAuth([apiKeyAuth('partner', PARTNER_CREDENTIALS)])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    reindex(request: ReindexRequest): Promise<ReindexResponse> {
        throw new Error('Method reindex() must be implemented by subclass');
    }
}
