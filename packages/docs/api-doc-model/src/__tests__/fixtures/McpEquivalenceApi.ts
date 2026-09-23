import 'reflect-metadata';
import {
    ApiPath,
    ApiType,
    Endpoint,
    Integer,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WRITE_IDEMPOTENT,
    WpAuthJwt,
    WpMax,
    WpMcpAuthJwt,
    WpMcpTool,
    WpMin,
} from '@webpieces/core-util';

/** Where an order is in its lifecycle. */
export type OrderPhase = 'placed' | 'done';

/**
 * One page of a listing.
 *
 * A CLASS and not an interface because `@WpMin`/`@WpMax` are property decorators and an interface
 * has nowhere to hang one. A bound is policy, which no TypeScript type can state.
 */
export class PageRequest {
    /** Opaque cursor from the previous response. */
    cursor!: string;

    /** How many orders to return. */
    @WpMin(1)
    @WpMax(50)
    size!: Integer;
}

/** One label attached at placement. */
export interface LabelSpec {
    /** The label's value. */
    value: string;
}

/** Everything the lookup tool accepts. See {@link PageRequest} for why this is a class. */
export class LookupRequest {
    /**
     * The store to read.
     * @mcpHeader store-id
     */
    storeId!: string;

    /** Only orders in this phase. */
    phase?: OrderPhase;

    /** The most orders to return. */
    @WpMin(1)
    @WpMax(100)
    limit?: Integer;

    /** Include orders the store has archived. */
    includeArchived?: boolean;

    /** Only orders carrying every one of these tags. */
    tags?: string[];

    /** Only these internal order numbers. A bound on an ARRAY lands on its ITEM. */
    @WpMin(1)
    orderNumbers?: Integer[];

    /** Free-form equality filters applied to the order record. */
    filters?: Record<string, string>;

    /** Labels to match, by label name. */
    labels?: Record<string, LabelSpec>;

    /** Where in the listing to resume. */
    page?: PageRequest;
}

/** One order, as the lookup tool reports it. */
export interface OrderSummary {
    /** Our identifier for it. */
    id: string;

    /** Where it is in its lifecycle. */
    phase: OrderPhase;

    /** What the customer paid, in cents. */
    totalCents: Integer;

    /**
     * The store's own identifier for it, PRESENT and `null` when the store has none — which is a
     * different wire document from omitting the key, and a distinction the deleted reflect-metadata
     * runtime could neither see nor write down.
     */
    externalId: string | null;
}

/** What the lookup tool returns. */
export interface LookupResponse {
    /** The matching orders, newest first. */
    orders: OrderSummary[];

    /** Pass as the next cursor; absent when the listing is exhausted. */
    nextCursor?: string;
}

/** Everything the cancel tool accepts. */
export interface CancelRequest {
    /** The order to cancel. */
    orderId: string;

    /** Why, for the store's records. */
    reason: string;
}

/** What the cancel tool returns. */
export interface CancelResponse {
    /** The order's phase after the attempt. */
    phase: OrderPhase;
}

/** Everything the reindex tool accepts. */
export interface ReindexRequest {
    /** The store whose cache to rebuild. */
    storeId: string;
}

/** What the reindex tool returns. */
export interface ReindexResponse {
    /** How many menu items were re-read. */
    itemsRead: Integer;
}

/**
 * The contract the MCP schema gate renders, and the golden `mcp-McpEquivalenceApi-tools.json` is the
 * REGRESSION guard: a change that moves a live tool's input schema shows up as a diff a human reads.
 *
 * ## What it used to be, and why that is over
 *
 * Until #984 every field here stated its shape TWICE — once to the runtime as
 * `@WpDtoField(new WpDtoFieldOptions(...))`, once to the compiler as its declared type plus JSDoc —
 * and the spec asserted the two schemas were equal. They were, for every shape the runtime could
 * build (#983), which is what licensed deleting the runtime half. What is left is the declaration
 * that was always the real one.
 *
 * ## Three shapes it deliberately carries, because the deleted runtime could not
 *
 * - **NAMED TYPE ALIASES** — `phase: OrderPhase`, `size: Integer`. `design:type` resolved to
 *   `String`/`Number` under `tsc` and to `Object` under SWC, where `DtoSchemaBuilder` refused the DTO
 *   outright, so the runtime's view of an aliased field depended on the TRANSPILER. `Integer` —
 *   #981's preferred spelling of integer-ness — was therefore unusable on a runtime-registered DTO at
 *   all. The compiler walks the written syntax and has no such problem.
 * - **A NULLABLE field** — `externalId: string | null`, rendered `type: ["string", "null"]`.
 * - **A BOUND ON AN ARRAY's items** — `@WpMin`/`@WpMax` land on the numeric leaf, where OpenAPI puts
 *   them; `@WpDtoField` rejected numeric constraints on a non-`Number` field.
 */
@ApiPath('/equivalence')
@ApiType(SVC_TO_SVC, MCP)
export abstract class McpEquivalenceApi {
    // The READ row of the hint table: `readOnlyHint` true, `destructiveHint` false,
    // `idempotentHint` true, all three computed from `READ` rather than declared. It is a `//`
    // comment and not part of the JSDoc because the JSDoc BODY is the published tool description,
    // and this paragraph is for whoever maintains the fixture.
    /** Looks up orders at one store, newest first. */
    @Endpoint(POST, '/lookup', READ, RPC)
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpMcpTool('lookup_orders')
    lookup(_request: LookupRequest): Promise<LookupResponse> {
        throw new Error('contract only');
    }

    // The WRITE row: not read-only, destructive, NOT idempotent. `openWorld` is declared on
    // `@Endpoint`'s options, which is where the fourth hint lives after #982.
    /** Cancels one order. */
    @Endpoint(POST, '/cancel', WRITE, RPC, { openWorld: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpMcpTool('cancel_order')
    cancel(_request: CancelRequest): Promise<CancelResponse> {
        throw new Error('contract only');
    }

    // The WRITE_IDEMPOTENT row: destructive AND idempotent. `hidden` keeps it out of the customer
    // document and leaves it in the MCP one, which is the combination most likely to be got wrong.
    /** Rebuilds a store's menu cache. */
    @Endpoint(POST, '/reindex', WRITE_IDEMPOTENT, RPC, { hidden: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpMcpTool('reindex_store')
    reindex(_request: ReindexRequest): Promise<ReindexResponse> {
        throw new Error('contract only');
    }
}
