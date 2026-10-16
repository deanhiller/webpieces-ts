import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    HeaderRegistry,
    MCP,
    McpToolCatalogFile,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    jwt,
} from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpToolCatalog } from './McpToolCatalog';
import { WpMcpServer } from './WpMcpServer';
import { McpHttpTestHarness, TestServers } from './__tests__/McpHttpTestHarness';
import { TestJwtHook, TestTokenAuthority, USER_ID } from './__tests__/WpMcpServerTestFixtures';

/**
 * What an MCP CLIENT is told, end to end (#1292): the tool catalog `wp-openapi` GENERATED from the
 * example partner contract, booted by the real `WpMcpServer` and read back through `tools/list`.
 *
 * It also proves the tool's TITLE has one source end to end (#1296): the method's `@summary` JSDoc
 * tag, which the generator writes into the catalog and the server serves as BOTH `Tool.title` and
 * `annotations.title` — the decorator carries no title any more.
 *
 * The catalog is the partner-api golden — the exact bytes `openapi-golden.spec.ts` proves the generator
 * writes from `apps/app-example/partner-api/src/PartnerOrdersApi.ts` — read as a FILE rather than
 * hand-built, so this spec checks the generated descriptions and not a copy of them. The runtime does
 * not depend on the compiler API, so the contract is re-declared here with the same tool name, summary
 * and method: the registry pairs a binding with its catalog by contract CLASS NAME.
 *
 * The source carries a `@privateRemarks` on both the method and the request DTO; the generator drops
 * them (rule 1), and this proves nothing downstream re-introduces them. It also proves the server
 * serves the root `inputSchema` / `outputSchema` descriptions the generator now writes — the request
 * DTO's JSDoc and the method's `@returns` (rule 2) — and every field's own JSDoc (rule 3).
 */
const PARTNER_SRC = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'app-example', 'partner-api', 'src');

const GOLDEN = path.join(
    PARTNER_SRC,
    '__tests__',
    'goldens',
    McpToolCatalogFile.fileNameFor('PartnerOrdersApi'),
);

/**
 * The `@summary` line of `fetchOrders` in the REAL contract source, read as text — so the assertion
 * below compares what an MCP client is served with what the author wrote, not with a copy of it.
 */
function summaryInContractSource(): string {
    const source = fs.readFileSync(path.join(PARTNER_SRC, 'PartnerOrdersApi.ts'), 'utf8');
    const method = source.indexOf('fetchOrders(request');
    const block = source.slice(source.lastIndexOf('/**', method), method);
    const line = /^\s*\*\s*@summary\s+(.+?)\s*$/m.exec(block);
    if (line === null) throw new Error('PartnerOrdersApi.fetchOrders has no summary JSDoc tag');
    return line[1];
}

class FetchOrdersRequest {
    /** The store to read. */
    storeId!: string;
}

class FetchOrdersResponse {
    /** The matching orders, newest first. */
    orders!: string[];
}

/** The example partner contract's MCP tool, re-declared — see the spec's doc for why. */
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

@injectable()
class PartnerOrdersController extends PartnerOrdersApi {
    override async fetchOrders(_request: FetchOrdersRequest): Promise<FetchOrdersResponse> {
        throw new Error('tools/list never invokes the tool');
    }
}

describe('the descriptions an MCP client is served from a GENERATED catalog (#1292)', () => {
    const mountPath = '/mcp/described';
    let bridge: WpMcpServer<string>;
    let client: McpHttpTestHarness;
    let http: Server;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TestJwtHook());
                }),
            ],
        });
        router.addRoutes(PartnerOrdersApi, PartnerOrdersController);
        const catalog = new McpToolCatalog(
            McpToolCatalogFile.fromJsonText(path.basename(GOLDEN), fs.readFileSync(GOLDEN, 'utf8')),
            path.dirname(GOLDEN),
        );
        const app = express();
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string>()
                .setName('described')
                .setTitle('Webpieces Test Server')
                .setDescription('Exercises the webpieces MCP bridge in the mcp-server test suite.')
                .setWebsiteUrl('https://docs.example.test/mcp')
                .setVersion('1')
                .setResource(`https://api.example.test${mountPath}`)
                .setAccessTokenAuthority(new TestTokenAuthority())
                .setAuthorizationService(router.authorizationService())
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']),
        );
        bridge.bind(
            app,
            new McpBindOptions(
                mountPath,
                [McpApiBinding.local(PartnerOrdersApi, router)],
                [catalog],
                McpDeployment.singleProcess(),
            ),
        );
        http = await TestServers.listen(app);
        client = new McpHttpTestHarness(TestServers.urlOf(http), mountPath);
    });

    afterAll(async () => {
        await bridge.close();
        await TestServers.close(http);
    });

    async function listedTool(): Promise<Record<string, unknown>> {
        const reply = await client.post(client.request('tools/list'), 'mcp-user');
        const tools = client.resultOf(reply.payload)['tools'] as Array<Record<string, unknown>>;
        expect(tools).toHaveLength(1);
        return tools[0];
    }

    it('serves NO @privateRemarks text anywhere in the tool', async () => {
        const served = JSON.stringify(await listedTool());
        expect(served).not.toContain('read replica');
        expect(served).not.toContain('must appear in NO generated document');
        expect(served).not.toContain('privateRemarks');
    });

    it("serves the method's @returns as the outputSchema's description", async () => {
        const output = (await listedTool())['outputSchema'] as Record<string, unknown>;
        expect(output['description']).toBe(
            'The page of matching orders, newest first, with `nextFrom` set while more remain.',
        );
    });

    it("serves the request DTO's JSDoc as the inputSchema's description, and every field's own", async () => {
        const input = (await listedTool())['inputSchema'] as Record<string, unknown>;
        expect(input['description']).toBe(
            "Which orders to fetch: one store's orders inside a time window, optionally narrowed by state.",
        );
        const properties = input['properties'] as Record<string, Record<string, unknown>>;
        for (const [name, property] of Object.entries(properties)) {
            expect(String(property['description'] ?? '').trim(), name).not.toBe('');
        }
    });

    it("serves the method's summary JSDoc tag as BOTH Tool.title and annotations.title (#1296)", async () => {
        const summary = summaryInContractSource();
        expect(summary).toBe('Fetch your orders');
        const tool = await listedTool();
        expect(tool['title']).toBe(summary);
        expect((tool['annotations'] as Record<string, unknown>)['title']).toBe(summary);
        expect(String(tool['description'])).not.toContain(summary);
    });

    it('serves the agent-facing @mcp text as the tool description, without the private note', async () => {
        const tool = await listedTool();
        expect(tool['description']).toContain('Call this before answering any question about recent orders');
    });
});
