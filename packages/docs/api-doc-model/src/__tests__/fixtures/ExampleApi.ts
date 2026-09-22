/* eslint-disable */
/**
 * The MAIN fixture contract. Every row of the vitest matrix in issue #981 is written here rather
 * than assembled in the spec, so what the extractor reads is ordinary TypeScript somebody could
 * plausibly have written, not a synthetic AST — and it uses the REAL decorators, so it cannot drift
 * from the signatures it exists to exercise.
 */
import {
    ApiPath,
    ApiType,
    CLOUDTASKS,
    CRON,
    Endpoint,
    EXTERNAL,
    EXTERNAL_CUSTOMER,
    GET,
    Integer,
    MaskLog,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WpAuthApiKey,
    WpAuthJwt,
    WpAuthPublic,
    WpInt,
    WpMax,
    WpMcpAuthJwt,
    WpMcpTool,
    WpMin,
} from '@webpieces/core-util';
import { SAVE_PATH } from './contract-constants';

/** A string-literal union with a NAME — becomes one enum entry a renderer can `$ref`. */
export type Color = 'red' | 'green' | 'blue';

/** A DTO reachable from the request, exercising optional vs nullable, `@format` and `@mcp`. */
export interface Customer {
    /** The customer's login address. @format email */
    email: string;

    /**
     * What they like to be called.
     *
     * OPTIONAL: the property may be ABSENT.
     */
    nickname?: string;

    /**
     * Their middle name.
     *
     * NULLABLE: the property is PRESENT and may hold null. `{}` and `{middleName: null}` are
     * different wire documents, which is why the model keeps the two apart.
     */
    middleName: string | null;

    /** Favourite colour. */
    colour: Color;

    /** Free-form labels. */
    tags: Record<string, string>;

    /** When each visit happened. @format date-time */
    visitedAt: string[];

    /**
     * How many orders they have placed.
     *
     * @mcp The lifetime order count. Prefer filtering on this over fetching every order.
     */
    orderCount: Integer;
}

/** A self-referential DTO. It terminates because a NAMED type is ONE model entry. */
export interface TreeNode {
    name: string;
    children: TreeNode[];
    parent?: TreeNode;
}

/** A deep-but-FINITE chain: 8 named hops, every one of which must appear in the model. */
export interface Hop1 {
    next: Hop2;
}
export interface Hop2 {
    next: Hop3;
}
export interface Hop3 {
    next: Hop4;
}
export interface Hop4 {
    next: Hop5;
}
export interface Hop5 {
    next: Hop6;
}
export interface Hop6 {
    next: Hop7;
}
export interface Hop7 {
    next: Hop8;
}
export interface Hop8 {
    leaf: string;
}

/** A DISCRIMINATED union: every branch carries `kind` as ONE string literal. */
export interface Circle {
    kind: 'circle';
    radius: number;
}
export interface Square {
    kind: 'square';
    side: number;
}
/** Pick one. */
export type Shape = Circle | Square;

/** A union TypeScript itself cannot narrow — no shared single-literal property. */
export interface Alpha {
    a: string;
}
export interface Beta {
    b: string;
}
export type Mixed = Alpha | Beta;

export interface SaveRequest {
    customer: Customer;
    tree: TreeNode;
    chain: Hop1;
    shape: Shape;
    mixed: Mixed;
}

export interface SaveResponse {
    saved: boolean;
}

export interface EnqueueRequest {
    payload: string;
}

export interface NightlyRequest {
    isoDate: string;
}

export interface WebhookRequest {
    From: string;
}

export interface InternalRequest {
    reason: string;
}

export interface LookupRequest {
    key: string;
}

/** Integer-ness by the PREFERRED spelling: the type composes. */
export interface LimitByAlias {
    limit?: Integer;
    counts: Integer[];
    quotas: Record<string, Integer>;
}

/**
 * Integer-ness by the OTHER accepted spelling, producing identical model output.
 *
 * A CLASS rather than an interface because TypeScript decorators only attach to class members —
 * which is itself part of why `Integer` is the preferred spelling: it needs no carrier.
 */
export class LimitByDecorator {
    @WpInt() limit?: number;
    @WpInt() counts!: number[];
    @WpInt() quotas!: Record<string, number>;
}

export class BoundedRequest {
    /** Page size. */
    @WpMin(1)
    @WpMax(100)
    pageSize!: Integer;
}

/**
 * The example contract.
 *
 * It links {@link Customer.email} on purpose: inline links are flattened at extraction, so no
 * renderer ever has to know the JSDoc inline-tag grammar.
 */
@ApiPath('/api/example')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class ExampleApi {
    /**
     * Save a customer.
     *
     * @mcp Create or update one customer record. Safe to retry.
     */
    @Endpoint(POST, SAVE_PATH, WRITE, RPC)
    @WpAuthJwt({ allRolesAllowed: true })
    @WpMcpTool({
        name: 'save_customer',
        description: 'Create or update one customer.',
        openWorldHint: false,
    })
    @WpMcpAuthJwt({ roles: ['admin'] })
    @MaskLog({ secretToken: 'full' })
    save(request: SaveRequest): Promise<SaveResponse> {
        throw new Error('contract');
    }

    /** Enqueued by a producer, delivered later. */
    @Endpoint(POST, '/enqueue', WRITE, CLOUDTASKS)
    @WpAuthJwt({ allRolesAllowed: true })
    enqueue(request: EnqueueRequest): Promise<void> {
        throw new Error('contract');
    }

    /** Fired by a scheduler on a clock. */
    @Endpoint(POST, '/nightly', WRITE, CRON)
    @WpAuthJwt({ allRolesAllowed: true })
    nightly(request: NightlyRequest): Promise<void> {
        throw new Error('contract');
    }

    /** Posted by a vendor. */
    @Endpoint(POST, '/hook', WRITE, EXTERNAL, {
        formPost: true,
        calledBy: 'twilio',
        callerKind: 'saas',
        openWorld: true,
    })
    @WpAuthPublic('Twilio signs its own payload; the webhook callback verifies it.')
    hook(request: WebhookRequest): Promise<void> {
        throw new Error('contract');
    }

    /**
     * Plumbing nobody should see in the customer document.
     *
     * Not published: an operator tool, and the customer contract has no concept of our internals.
     */
    @Endpoint(POST, '/internal', WRITE, RPC, { hidden: true })
    @WpAuthJwt({ allRolesAllowed: true })
    internal(request: InternalRequest): Promise<void> {
        throw new Error('contract');
    }

    /**
     * Look one customer up by key.
     *
     * An api-key regime authenticates a PAIR, which is why both credentials are declared here and
     * why a renderer must AND them into one requirement rather than list them separately.
     */
    @Endpoint(POST, '/lookup', READ, RPC)
    @WpAuthApiKey('partner', [
        { in: 'header', name: 'x-api-key', description: 'Your partner key.' },
        { in: 'bearer', description: 'The organization the key acts for.' },
    ])
    lookup(request: LookupRequest): Promise<void> {
        throw new Error('contract');
    }

    /** Integer-ness, the preferred spelling. */
    @Endpoint(GET, '/limit-alias', READ, RPC)
    @WpAuthJwt({ allRolesAllowed: true })
    limitAlias(request: LimitByAlias): Promise<void> {
        throw new Error('contract');
    }

    /** Integer-ness, the decorator spelling. */
    @Endpoint(POST, '/limit-decorator', READ, RPC)
    @WpAuthJwt({ allRolesAllowed: true })
    limitDecorator(request: LimitByDecorator): Promise<void> {
        throw new Error('contract');
    }

    /** Numeric bounds. */
    @Endpoint(POST, '/bounded', READ, RPC)
    @WpAuthJwt({ allRolesAllowed: true })
    bounded(request: BoundedRequest): Promise<void> {
        throw new Error('contract');
    }
}
