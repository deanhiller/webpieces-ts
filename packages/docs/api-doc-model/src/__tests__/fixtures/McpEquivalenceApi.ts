import 'reflect-metadata';
import {
    ApiPath,
    ApiType,
    Endpoint,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WRITE_IDEMPOTENT,
    WpAuthJwt,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpDtoMapFieldOptions,
    WpInt,
    WpMax,
    WpMcpAuthJwt,
    WpMcpHeader,
    WpMcpTool,
    WpMin,
    WpResponseDto,
} from '@webpieces/core-util';

/** One page of a listing. */
@WpDto()
export class PageRequest {
    /** Opaque cursor from the previous response. */
    @WpDtoField(new WpDtoFieldOptions('Opaque cursor from the previous response.', true))
    cursor!: string;

    /** How many orders to return. */
    @WpDtoField(new WpDtoFieldOptions('How many orders to return.', true, undefined, true, 1, 50))
    @WpInt()
    @WpMin(1)
    @WpMax(50)
    size!: number;
}

/** One label attached at placement. */
@WpDto()
export class LabelSpec {
    /** The label's value. */
    @WpDtoField(new WpDtoFieldOptions("The label's value.", true))
    value!: string;
}

/** Everything the lookup tool accepts. */
@WpDto()
export class LookupRequest {
    /**
     * The store to read.
     * @mcpHeader store-id
     */
    @WpDtoField(
        new WpDtoFieldOptions(
            'The store to read.',
            true,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            new WpMcpHeader('store-id'),
        ),
    )
    storeId!: string;

    /** Only orders in this phase. */
    @WpDtoField(
        new WpDtoFieldOptions(
            'Only orders in this phase.',
            false,
            undefined,
            false,
            undefined,
            undefined,
            ['placed', 'done'] as const,
        ),
    )
    phase?: 'placed' | 'done';

    /** The most orders to return. */
    @WpDtoField(new WpDtoFieldOptions('The most orders to return.', false, undefined, true, 1, 100))
    @WpInt()
    @WpMin(1)
    @WpMax(100)
    limit?: number;

    /** Include orders the store has archived. */
    @WpDtoField(new WpDtoFieldOptions('Include orders the store has archived.', false))
    includeArchived?: boolean;

    /** Only orders carrying every one of these tags. */
    @WpDtoField(
        new WpDtoFieldOptions('Only orders carrying every one of these tags.', false, 'string'),
    )
    tags?: string[];

    /** Only these internal order numbers. */
    @WpDtoField(new WpDtoFieldOptions('Only these internal order numbers.', false, 'integer'))
    @WpInt()
    orderNumbers?: number[];

    /** Free-form equality filters applied to the order record. */
    @WpDtoField(
        new WpDtoMapFieldOptions(
            'Free-form equality filters applied to the order record.',
            false,
            'string',
        ),
    )
    filters?: Record<string, string>;

    /** Labels to match, by label name. */
    @WpDtoField(new WpDtoMapFieldOptions('Labels to match, by label name.', false, LabelSpec))
    labels?: Record<string, LabelSpec>;

    /** Where in the listing to resume. */
    @WpDtoField(new WpDtoFieldOptions('Where in the listing to resume.', false))
    page?: PageRequest;
}

/** One order, as the lookup tool reports it. */
@WpDto()
export class OrderSummary {
    /** Our identifier for it. */
    @WpDtoField(new WpDtoFieldOptions('Our identifier for it.', true))
    id!: string;

    /** Where it is in its lifecycle. */
    @WpDtoField(
        new WpDtoFieldOptions(
            'Where it is in its lifecycle.',
            true,
            undefined,
            false,
            undefined,
            undefined,
            ['placed', 'done'] as const,
        ),
    )
    phase!: 'placed' | 'done';

    /** What the customer paid, in cents. */
    @WpDtoField(new WpDtoFieldOptions('What the customer paid, in cents.', true, undefined, true))
    @WpInt()
    totalCents!: number;
}

/** What the lookup tool returns. */
@WpDto()
export class LookupResponse {
    /** The matching orders, newest first. */
    @WpDtoField(new WpDtoFieldOptions('The matching orders, newest first.', true, OrderSummary))
    orders!: OrderSummary[];

    /** Pass as the next cursor; absent when the listing is exhausted. */
    @WpDtoField(
        new WpDtoFieldOptions(
            'Pass as the next cursor; absent when the listing is exhausted.',
            false,
        ),
    )
    nextCursor?: string;
}

/** Everything the cancel tool accepts. */
@WpDto()
export class CancelRequest {
    /** The order to cancel. */
    @WpDtoField(new WpDtoFieldOptions('The order to cancel.', true))
    orderId!: string;

    /** Why, for the store's records. */
    @WpDtoField(new WpDtoFieldOptions("Why, for the store's records.", true))
    reason!: string;
}

/** What the cancel tool returns. */
@WpDto()
export class CancelResponse {
    /** The order's phase after the attempt. */
    @WpDtoField(
        new WpDtoFieldOptions(
            "The order's phase after the attempt.",
            true,
            undefined,
            false,
            undefined,
            undefined,
            ['placed', 'done'] as const,
        ),
    )
    phase!: 'placed' | 'done';
}

/** Everything the reindex tool accepts. */
@WpDto()
export class ReindexRequest {
    /** The store whose cache to rebuild. */
    @WpDtoField(new WpDtoFieldOptions('The store whose cache to rebuild.', true))
    storeId!: string;
}

/** What the reindex tool returns. */
@WpDto()
export class ReindexResponse {
    /** How many menu items were re-read. */
    @WpDtoField(new WpDtoFieldOptions('How many menu items were re-read.', true, undefined, true))
    @WpInt()
    itemsRead!: number;
}

/**
 * The DOUBLE-DECLARED contract the equivalence gate (#983) measures.
 *
 * Every DTO field here states its shape TWICE, on purpose:
 *
 * - to the RUNTIME, as `@WpDtoField(new WpDtoFieldOptions(...))` — which is the only way
 *   `DtoSchemaBuilder` can learn that a field is required, that an array holds strings, or that a
 *   number is an integer, because TypeScript erases all three;
 * - to the COMPILER, as the declared type plus JSDoc — which is what `@webpieces/api-doc-model`
 *   reads.
 *
 * The spec beside it builds both schemas and asserts they are EQUAL. That is the whole evidence #984
 * is waiting on: it deletes the first declaration, and a tool whose input schema quietly loses a
 * `required` entry or an `enum` fails agent calls at runtime rather than at build.
 *
 * ## Why the prose is duplicated byte-for-byte
 *
 * Each field's JSDoc sentence is the SAME STRING as its `WpDtoFieldOptions` description. That is not
 * laziness, it is the assertion: the settled design says documentation has ONE source (JSDoc), and
 * this fixture is what a contract looks like the moment before the decorator's copy is deleted. A
 * fixture whose two copies differed would make the gate measure a typo instead of a mechanism.
 *
 * ## Two shapes are deliberately ABSENT, and both are findings rather than oversights
 *
 * - **A field typed with a NAMED type alias** (`phase: OrderPhase`, `size: Integer`). Under `tsc`,
 *   `design:type` resolves to `String` / `Number`; under SWC — which is what vitest and several
 *   bundlers use — it emits `Object`, and `DtoSchemaBuilder` then refuses the DTO outright. So the
 *   runtime's view of an aliased field depends on the TRANSPILER, and the fixture writes the unions
 *   inline. The compiler has no such problem, which is one more reason the extraction belongs there.
 * - **A NULLABLE field** (`externalId: string | null`). `design:type` is `Object` for it, so the
 *   runtime cannot carry one at all; `ApiJsonSchema.type` holds a single string, so it could not
 *   publish one either. The compiler sees it perfectly.
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
    @WpMcpTool({
        name: 'lookup_orders',
        description: 'Looks up orders at one store, newest first.',
        openWorldHint: false,
    })
    @WpResponseDto(() => LookupResponse)
    lookup(_request: LookupRequest): Promise<LookupResponse> {
        throw new Error('contract only');
    }

    // The WRITE row: not read-only, destructive, NOT idempotent. `openWorld` is declared on
    // `@Endpoint`'s options, which is where the fourth hint lives after #982.
    /** Cancels one order. */
    @Endpoint(POST, '/cancel', WRITE, RPC, { openWorld: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpMcpTool({
        name: 'cancel_order',
        description: 'Cancels one order.',
        openWorldHint: true,
    })
    @WpResponseDto(() => CancelResponse)
    cancel(_request: CancelRequest): Promise<CancelResponse> {
        throw new Error('contract only');
    }

    // The WRITE_IDEMPOTENT row: destructive AND idempotent. `hidden` keeps it out of the customer
    // document and leaves it in the MCP one, which is the combination most likely to be got wrong.
    /** Rebuilds a store's menu cache. */
    @Endpoint(POST, '/reindex', WRITE_IDEMPOTENT, RPC, { hidden: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpMcpTool({
        name: 'reindex_store',
        description: "Rebuilds a store's menu cache.",
        openWorldHint: false,
    })
    @WpResponseDto(() => ReindexResponse)
    reindex(_request: ReindexRequest): Promise<ReindexResponse> {
        throw new Error('contract only');
    }
}
