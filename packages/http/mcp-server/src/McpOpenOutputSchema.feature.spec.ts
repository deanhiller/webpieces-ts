import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, Tool } from '@modelcontextprotocol/client';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    HeaderRegistry,
    MCP,
    Mcp,
    McpToolCatalogFile,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WebpiecesCoreHeaders,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    jwt,
} from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpToolCatalog } from './McpToolCatalog';
import { McpToolset } from './McpToolset';
import { WpMcpInMemory } from './WpMcpInMemory';
import { TransportJwtHook, VerifiedCaller } from './__tests__/McpTransportFixtures';

/**
 * #1441: a tool's PUBLISHED `outputSchema` is OPEN, so ADDING a response field never breaks a client
 * that is already connected.
 *
 * An MCP client (Claude Code, claude.ai, a ChatGPT connector) caches each tool's `outputSchema` from
 * `tools/list` when it connects, and the official SDK `Client` validates every `structuredContent`
 * against that cached copy. With `additionalProperties: false` on every object, the server's NEW
 * field was refused by every session connected before the deploy.
 *
 * Driven end to end: the catalog `wp-openapi` GENERATED for the example partner contract (the
 * partner-api golden, read as a file), the real `McpToolset`, and the official SDK `Client` over the
 * in-memory transport. The "connected before the deploy" client is the SDK's own escape hatch,
 * `callTool(..., { toolDefinition })`, handed the tool as served MINUS the fields the deploy added —
 * the SDK compiles exactly that definition, as it would have compiled its cached one.
 */
const GOLDEN = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'apps',
    'app-example',
    'partner-api',
    'src',
    '__tests__',
    'goldens',
    McpToolCatalogFile.fileNameFor('PartnerOrdersApi'),
);

const CALLER = new VerifiedCaller('alice', []);

class FetchOrdersRequest {
    /** The store to read. */
    storeId!: string;
}

class FetchOrdersResponse {
    /** The matching orders, newest first. */
    orders!: object[];
    /** Set while more remain. */
    nextFrom?: string;
}

/** The example partner contract's MCP tool, re-declared — see McpServedDescriptions for why. */
@ApiPath('/orders')
@ApiType(SVC_TO_SVC, MCP)
abstract class PartnerOrdersApi {
    /**
     * Returns every order placed at one store inside a time window, newest first.
     *
     * @summary Fetch your orders
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/fetch', READ, RPC)
    @WpMcpTool('fetch_orders')
    fetchOrders(_request: FetchOrdersRequest): Promise<FetchOrdersResponse> {
        throw new Error('contract');
    }
}

/** Answers what the NEW release sends: every field of the generated schema, `nextFrom` included. */
@injectable()
class PartnerOrdersController extends PartnerOrdersApi {
    /** When set, the controller returns a key its contract never declared (a server bug). */
    static undeclaredKey = false;

    override async fetchOrders(_request: FetchOrdersRequest): Promise<FetchOrdersResponse> {
        const response = new FetchOrdersResponse();
        response.orders = [
            {
                id: 'o-1',
                state: 'placed',
                externalId: 'yours-1',
                placedAt: '2026-11-19T09:00:00Z',
                window: { kind: 'asap', estimateMinutes: 20 },
                labels: { tier: 'vip' },
            },
        ];
        response.nextFrom = '2026-11-19T08:00:00Z';
        if (PartnerOrdersController.undeclaredKey) {
            Object.assign(response, { internalShard: 7 });
        }
        return response;
    }
}

// webpieces-disable no-any-unknown -- walking an arbitrary JSON schema tree
function closedObjectPaths(node: unknown, at: string, found: string[]): string[] {
    if (Array.isArray(node)) {
        // webpieces-disable no-any-unknown -- walking an arbitrary JSON schema tree
        node.forEach((child: unknown, index: number) =>
            closedObjectPaths(child, `${at}[${index}]`, found),
        );
    } else if (node !== null && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
            if (key === 'additionalProperties' && child === false) found.push(at);
            closedObjectPaths(child, `${at}.${key}`, found);
        }
    }
    return found;
}

/**
 * The tool as a client connected BEFORE the deploy cached it: the same published schema without the
 * two fields the deploy added — `nextFrom` at the root and `externalId` on each nested order.
 */
function cachedBeforeTheDeploy(served: Tool): Tool {
    const old = JSON.parse(JSON.stringify(served)) as Tool;
    const root = old.outputSchema as Record<string, Record<string, unknown>>;
    delete root['properties']['nextFrom'];
    const orders = root['properties']['orders'] as Record<string, Record<string, unknown>>;
    const order = orders['items'];
    delete (order['properties'] as Record<string, unknown>)['externalId'];
    order['required'] = (order['required'] as string[]).filter(
        (name: string) => name !== 'externalId',
    );
    return old;
}

/** What every release before #1441 published: the same schema closed at every object. */
// webpieces-disable no-any-unknown -- rewriting an arbitrary JSON schema tree
function closeEveryObject(node: unknown): void {
    if (Array.isArray(node)) {
        // webpieces-disable no-any-unknown -- rewriting an arbitrary JSON schema tree
        node.forEach((child: unknown) => closeEveryObject(child));
    } else if (node !== null && typeof node === 'object') {
        const record = node as Record<string, unknown>;
        if (record['type'] === 'object' && record['additionalProperties'] === undefined) {
            record['additionalProperties'] = false;
        }
        // webpieces-disable no-any-unknown -- rewriting an arbitrary JSON schema tree
        Object.values(record).forEach((child: unknown) => closeEveryObject(child));
    }
}

describe('MCP outputSchema is published OPEN, so adding a response field is safe (#1441)', () => {
    let client: Client;

    beforeAll(async () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TransportJwtHook());
                }),
            ],
        });
        router.addRoutes(PartnerOrdersApi, PartnerOrdersController);
        const catalog = new McpToolCatalog(
            McpToolCatalogFile.fromJsonText(path.basename(GOLDEN), fs.readFileSync(GOLDEN, 'utf8')),
            path.dirname(GOLDEN),
        );
        client = await WpMcpInMemory.connect(
            new McpToolset(
                [McpApiBinding.local(PartnerOrdersApi, router)],
                [catalog],
                router.authorizationService(),
                [Mcp.DEFAULT],
            ),
        );
    });

    async function servedTool(): Promise<Tool> {
        const listed = await CALLER.run(() => client.listTools());
        expect(listed.tools.map((tool: Tool) => tool.name)).toEqual(['fetch_orders']);
        return listed.tools[0];
    }

    it('tools/list publishes outputSchema with no additionalProperties:false at ANY depth, and inputSchema still closed', async () => {
        const tool = await servedTool();
        expect(closedObjectPaths(tool.outputSchema, '$', [])).toEqual([]);
        // The nested order and both union branches are objects too — prove the walk reached them.
        expect(JSON.stringify(tool.outputSchema)).toContain('"estimateMinutes"');
        expect(tool.inputSchema['additionalProperties']).toBe(false);
    });

    it("a client that cached the PRE-deploy outputSchema accepts the new release's added fields", async () => {
        const old = cachedBeforeTheDeploy(await servedTool());

        const result = await CALLER.run(() =>
            client.callTool(
                { name: 'fetch_orders', arguments: { storeId: 's-1' } },
                { toolDefinition: old },
            ),
        );

        expect(result.isError).not.toBe(true);
        const structured = result.structuredContent as Record<string, unknown>;
        expect(structured['nextFrom']).toBe('2026-11-19T08:00:00Z');
        expect((structured['orders'] as Array<Record<string, unknown>>)[0]['externalId']).toBe(
            'yours-1',
        );
    });

    it('the same client, holding the CLOSED schema every earlier release published, refuses that response — the bug', async () => {
        const old = cachedBeforeTheDeploy(await servedTool());
        closeEveryObject(old.outputSchema);

        const refusal = await CALLER.run(() =>
            client
                .callTool(
                    { name: 'fetch_orders', arguments: { storeId: 's-1' } },
                    { toolDefinition: old },
                )
                .then(
                    () => undefined,
                    (error: Error) => error,
                ),
        );

        expect(refusal?.message).toContain("does not match the tool's output schema");
    });

    it('inputs are still refused on an unknown key: inputSchema stays closed', async () => {
        const result = await CALLER.run(() =>
            client.callTool({ name: 'fetch_orders', arguments: { storeId: 's-1', storeID: 'typo' } }),
        );
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('storeID is not allowed');
    });

    it('the server still refuses its OWN result carrying a key the contract never declared', async () => {
        PartnerOrdersController.undeclaredKey = true;
        const result = await CALLER.run(() =>
            client.callTool({ name: 'fetch_orders', arguments: { storeId: 's-1' } }),
        ).finally(() => {
            PartnerOrdersController.undeclaredKey = false;
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
    });
});
