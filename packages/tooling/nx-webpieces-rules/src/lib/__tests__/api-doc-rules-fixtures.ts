/**
 * The throwaway mini-workspace `api-doc-rules-scan.spec.ts` judges, split out of it because that file
 * is at its size limit.
 *
 * ## Why every contract body is INDENTED here
 *
 * `FixtureWorkspace.project` dedents by four before writing, so the file on disk has `@ApiPath(` at
 * column zero where the scan's own `DECLARES_CONTRACT` regex needs it — and this SOURCE file does
 * not. That matters: the repo sweep in `@webpieces/api-doc-model` finds contract files by TEXT
 * (`@WpMcpTool(` plus `@ApiPath(` at column zero) and skips `.spec.ts` on purpose, because a fixture
 * that deliberately breaks a rule is not a contract this repo publishes. A plain helper module
 * holding these strings at column zero is indistinguishable from a real contract to that sweep, and
 * turned it red. The indent is what makes this file honest to both readers.
 *
 * Every contract is ONE self-contained file: the decorators are declared beside the class rather
 * than imported, because the extractor matches them BY NAME on the syntax and a fixture that
 * imported them would be testing module resolution instead of the rule. The values in
 * `@Endpoint(...)` are the real strings the framework's constants hold (`'POST'`, `'read'`, `'rpc'`,
 * `'cloudtasks'`) — the extractor constant-folds that argument and rejects anything outside the set,
 * so a fixture cannot drift into a kind that does not exist.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectInfo } from '../project-info';

/** Decorator stubs, declared in every fixture file so nothing has to resolve across modules. */
export const DECORATORS = `export function ApiPath(_p: string): ClassDecorator { return (): void => undefined; }
    export function ApiType(..._t: string[]): ClassDecorator { return (): void => undefined; }
    export function Endpoint(_m: string, _p: string, _o: string, _k: string): MethodDecorator { return (): void => undefined; }
    export function WpAuthJwt(_r: object): MethodDecorator { return (): void => undefined; }
    export function WpMcpTool(_n: string): MethodDecorator { return (): void => undefined; }
    export function WpMcpAuthJwt(_r: object): MethodDecorator { return (): void => undefined; }
    export function InvalidEndpointForMcp(_r: string): MethodDecorator { return (): void => undefined; }
`;

/** One fixture project: `libraries/<name>/src/index.ts`, with its own tsconfig beside it. */
export class FixtureWorkspace {
    constructor(public readonly root: string) {}

    project(name: string, body: string): void {
        this.write(`libraries/${name}/src/index.ts`, `${DECORATORS}\n${dedent(body)}`);
        this.write(
            `libraries/${name}/tsconfig.json`,
            JSON.stringify({
                compilerOptions: { moduleResolution: 'node', experimentalDecorators: true },
                include: ['src/**/*.ts'],
            }),
        );
    }

    private write(relPath: string, contents: string): void {
        const abs = path.join(this.root, relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, contents);
    }
}

/** The `ProjectInfo` map the scan walks, for the named fixture projects. */
// webpieces-disable no-function-outside-class -- spec helper, beside the fixtures it serves
export function fixtureProjects(...names: string[]): Map<string, ProjectInfo> {
    const infos = new Map<string, ProjectInfo>();
    for (const name of names) {
        infos.set(name, new ProjectInfo(name, `libraries/${name}`, ['role:api-lib']));
    }
    return infos;
}

/**
 * THE ACCEPTANCE CONTRACT, half one: a contract with NO `@ApiType` at all.
 *
 * It must pass both rules — every type is expressible, every field is documented, the RPC names a
 * response DTO — and `mcpApiFixture` below is the SAME contract with the publishing decorators
 * added. If the rules pass here and generation fails there, the rules are incomplete and that is the
 * bug this feature exists to close.
 */
export const CLEAN_API = `/** Orders a partner may fetch. */
    @ApiPath('/orders')
    export abstract class CleanApi {
        /** Fetch one order by its id. */
        @Endpoint('POST', '/fetch', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        abstract fetch(request: FetchRequest): Promise<FetchResponse>;

        /** Accept a delivery receipt. Fire-and-forget by contract. */
        @Endpoint('POST', '/receipt', 'write', 'cloudtasks')
        abstract receipt(request: ReceiptRequest): Promise<void>;
    }

    /** What to fetch. */
    export interface FetchRequest {
        /** The order's stable id. */
        id: string;
    }

    /** The order. */
    export interface FetchResponse {
        /** The order's stable id. */
        id: string;
        /** Where it is in its lifecycle. */
        phase: 'placed' | 'done';
    }

    /** A delivery receipt. */
    export interface ReceiptRequest {
        /** The order this receipt is for. */
        orderId: string;
    }
`;

/** THE ACCEPTANCE CONTRACT, half two: the same contract once it is PUBLISHED, as a tool as well. */
export const MCP_API = `/** Orders a partner may fetch. */
    @ApiType('external-customer', 'mcp')
    @ApiPath('/orders')
    export abstract class PublishedApi {
        /** Fetch one order by its id. */
        @Endpoint('POST', '/fetch', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        @WpMcpAuthJwt({ allRolesAllowed: true })
        @WpMcpTool('fetch_order')
        abstract fetch(request: FetchRequest): Promise<FetchResponse>;
    }

    /** What to fetch. */
    export interface FetchRequest {
        /** The order's stable id. */
        id: string;
    }

    /** The order. */
    export interface FetchResponse {
        /** The order's stable id. */
        id: string;
        /** Where it is in its lifecycle. */
        phase: 'placed' | 'done';
    }
`;

/** #1010's exact shape, on a contract that declares NO `@ApiType` — the workspace-scope proof. */
export const OPEN_ENUM_API = `/** Store status. */
    @ApiPath('/status')
    export abstract class StoreStatusApi {
        /** List the discrepancies. */
        @Endpoint('POST', '/list', 'read', 'rpc')
        abstract list(request: ListRequest): Promise<ListResponse>;
    }

    /** Nothing to say. */
    export interface ListRequest {
        /** The store. */
        storeId: string;
    }

    /** The discrepancies. */
    export interface ListResponse {
        /** What was found. */
        found: Discrepancy;
    }

    /** One discrepancy. */
    export interface Discrepancy {
        /**
         * Treat as an OPEN enum — new classifications arrive additively.
         */
        classification?: 'pauseNotPropagated' | 'unexpectedPlatformPause' | string;
    }
`;

/** `TileCellValue = string | number | null` — the other of the two measured OpenAPI killers. */
export const MIXED_SCALAR_API = `/** Team dashboards. */
    @ApiPath('/dashboards')
    export abstract class TeamDashboardsApi {
        /** Query a dashboard. */
        @Endpoint('POST', '/query', 'read', 'rpc')
        abstract query(request: QueryRequest): Promise<QueryResponse>;
    }

    /** One cell of a tile. */
    export type TileCellValue = string | number | null;

    /** What to query. */
    export interface QueryRequest {
        /** The dashboard. */
        dashboardId: string;
    }

    /** The rows. */
    export interface QueryResponse {
        /** The first cell. */
        cell: TileCellValue;
    }
`;

/**
 * `unknown` VALUE TYPES, in all three real spellings, with the three disable states beside them:
 * an existing `no-any-unknown` disable (must NOT silence), a reasoned disable of this rule (must
 * silence), and a reasonless one (itself a violation).
 */
export const UNKNOWN_VALUE_API = `/** Promotions, published to partners. */
    @ApiType('external-customer')
    @ApiPath('/promotions')
    export abstract class PromotionsApi {
        /** Read a promotion. */
        @Endpoint('POST', '/read', 'read', 'rpc')
        abstract read(request: ReadRequest): Promise<ReadResponse>;
    }

    /** What to read. */
    export interface ReadRequest {
        /** The promotion. */
        promotionId: string;
    }

    /** The promotion. */
    export interface ReadResponse {
        /**
         * The mechanic-specific parameters.
         */
        // webpieces-disable no-any-unknown -- genuinely untyped: members differ per promoType
        discount?: Record<string, unknown>;
        /** The transport envelope's body. */
        // webpieces-disable api-rules-for-openapi -- a transport envelope's body is opaque by design; the published partner contract owns its shape
        data?: Record<string, unknown>;
        /** SQL bind parameters. */
        // webpieces-disable api-rules-for-openapi
        params?: unknown[];
    }
`;

/** An RPC that answers nothing, beside a cloudtasks endpoint that legitimately answers nothing. */
export const VOID_RPC_API = `/** Stores. */
    @ApiPath('/stores')
    export abstract class StoresApi {
        /** Pause a store. */
        @Endpoint('POST', '/pause', 'write', 'rpc')
        abstract pause(request: PauseRequest): Promise<void>;

        /** Reindex, in the background. */
        @Endpoint('POST', '/reindex', 'write', 'cloudtasks')
        abstract reindex(request: PauseRequest): Promise<void>;

        /** Sweep, nightly. */
        @Endpoint('POST', '/sweep', 'write', 'cron')
        abstract sweep(request: PauseRequest): Promise<void>;
    }

    /** Which store. */
    export interface PauseRequest {
        /** The store. */
        storeId: string;
    }
`;

/**
 * Every MCP-only refusal at once: a tool on a `cloudtasks` endpoint, a tool with no auth at all, and
 * a tool whose method carries no JSDoc.
 */
export const BAD_MCP_API = `/** Search. */
    @ApiType('mcp')
    @ApiPath('/search')
    export abstract class SearchApi {
        /** Enqueue a reindex. */
        @Endpoint('POST', '/reindex', 'write', 'cloudtasks')
        @WpAuthJwt({ allRolesAllowed: true })
        @WpMcpAuthJwt({ allRolesAllowed: true })
        @WpMcpTool('reindex_store')
        abstract reindex(request: SearchRequest): Promise<SearchResponse>;

        /** Search with no credential declared at all. */
        @Endpoint('POST', '/open', 'read', 'rpc')
        @WpMcpTool('open_search')
        abstract open(request: SearchRequest): Promise<SearchResponse>;

        @Endpoint('POST', '/quiet', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        @WpMcpAuthJwt({ allRolesAllowed: true })
        @WpMcpTool('quiet_search')
        abstract quiet(request: SearchRequest): Promise<SearchResponse>;
    }

    /** What to search for. */
    export interface SearchRequest {
        /** The term. */
        term: string;
    }

    /** What was found. */
    export interface SearchResponse {
        /** How many. */
        count: number;
    }
`;

/** A tool whose reachable DTO field has no JSDoc — the biggest measured bucket, 51 of 98 methods. */
export const UNDOCUMENTED_FIELD_API = `/** Widgets. */
    @ApiType('mcp')
    @ApiPath('/widgets')
    export abstract class WidgetsApi {
        /** List the widgets. */
        @Endpoint('POST', '/list', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        @WpMcpAuthJwt({ allRolesAllowed: true })
        @WpMcpTool('list_widgets')
        abstract list(request: ListRequest): Promise<ListResponse>;
    }

    /** What to list. */
    export interface ListRequest {
        ownerId: string;
    }

    /** The widgets. */
    export interface ListResponse {
        /** How many. */
        count: number;
    }
`;

/**
 * #1014's motivating case: a TRANSPORT contract whose `fanout` can never be a tool, beside a
 * `search` that is one. The reason on the decorator is the real one from the measured repo.
 */
export const EXCLUDED_API = `/** Webhooks. */
    @ApiType('mcp')
    @ApiPath('/webhooks')
    export abstract class PublicWebhooksApi {
        /** Search past deliveries. */
        @Endpoint('POST', '/search', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        @WpMcpAuthJwt({ allRolesAllowed: true })
        @WpMcpTool('search_deliveries')
        abstract search(request: SearchRequest): Promise<SearchResponse>;

        /** Fan a partner event out to its subscribers. */
        @Endpoint('POST', '/fanout', 'write', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        @InvalidEndpointForMcp('a transport envelope body is opaque by design; the published partner contract for each event type owns its shape')
        abstract fanout(request: FanoutRequest): Promise<FanoutResponse>;
    }

    /** What to search for. */
    export interface SearchRequest {
        /** The event type. */
        eventType: string;
    }

    /** What was found. */
    export interface SearchResponse {
        /** How many. */
        count: number;
    }

    /** One event to fan out. */
    export interface FanoutRequest {
        /** The event type. */
        eventType: string;
        /** The event body, owned by the published partner contract for this event type. */
        data?: Record<string, unknown>;
    }

    /** Accepted. */
    export interface FanoutResponse {
        /** How many subscribers it reached. */
        delivered: number;
    }
`;

/** Both decorators on ONE method — a contradiction the extractor refuses before a model exists. */
export const CONTRADICTS_API = `/** Search. */
    @ApiType('mcp')
    @ApiPath('/contradicts')
    export abstract class ContradictsApi {
        /** Search. */
        @Endpoint('POST', '/search', 'read', 'rpc')
        @WpAuthJwt({ allRolesAllowed: true })
        @WpMcpAuthJwt({ allRolesAllowed: true })
        @WpMcpTool('contradicting_search')
        @InvalidEndpointForMcp('a transport envelope body is opaque by design')
        abstract search(request: SearchRequest): Promise<SearchResponse>;
    }

    /** What to search for. */
    export interface SearchRequest {
        /** The term. */
        term: string;
    }

    /** What was found. */
    export interface SearchResponse {
        /** How many. */
        count: number;
    }
`;


/** Strips the four spaces this module indents every fixture by. See the file docstring. */
// webpieces-disable no-function-outside-class -- pure text helper, beside the writer that calls it
function dedent(body: string): string {
    return body.replace(/^ {4}/gm, '');
}
