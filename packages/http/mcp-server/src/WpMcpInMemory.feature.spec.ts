import 'reflect-metadata';
import { Client } from '@modelcontextprotocol/client';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { beforeAll, describe, expect, it } from 'vitest';
import { HeaderRegistry, Mcp, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouter, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpClientSet, McpDuplicateToolError } from './McpClientSet';
import { McpToolset } from './McpToolset';
import { WpMcpInMemory } from './WpMcpInMemory';
import { PROFILE_CATALOG, ProfileApi, ProfileController } from './__tests__/McpProfileFixtures';
import {
    STORE_CATALOG,
    StoreApi,
    StoreController,
    ServiceOnlyToolApi,
    ServiceOnlyToolController,
    StoreGate,
    TransportJwtHook,
    VerifiedCaller,
} from './__tests__/McpTransportFixtures';

const ALICE = new VerifiedCaller('alice', ['OPERATOR']);
const BOB = new VerifiedCaller('bob', []);

function toolNames(list: { tools: Array<{ name: string }> }): string[] {
    return list.tools.map((tool: { name: string }) => tool.name);
}

/**
 * The in-memory transport (#1416): ONE cached SDK client, the caller read from the CURRENT
 * RequestContext on every request — never captured at connect.
 */
describe('WpMcpInMemory: one shared client, the caller read per request', () => {
    let router: WebpiecesRouter;
    let client: Client;

    beforeAll(async () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, true);
        router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TransportJwtHook());
                }),
            ],
        });
        router.addRoutes(StoreApi, StoreController);
        router.addRoutes(ProfileApi, ProfileController);
        router.addRoutes(ServiceOnlyToolApi, ServiceOnlyToolController);
        const toolset = new McpToolset(
            [McpApiBinding.local(StoreApi, router)],
            [STORE_CATALOG],
            router.authorizationService(),
            ['user'],
        );
        client = await WpMcpInMemory.connect(toolset);
    });

    it('projects tools/list per caller: A (OPERATOR) and B (no role) each see only their own', async () => {
        const [alice, bob] = await Promise.all([
            ALICE.run(async () => toolNames(await client.listTools())),
            BOB.run(async () => toolNames(await client.listTools())),
        ]);
        expect(alice).toEqual(['stores_list', 'stores_pause']);
        expect(bob).toEqual(['stores_list']);
    });

    it("runs A's in-flight call as A while B, on the same client, is refused the X-only tool as unknown", async () => {
        const gate = new StoreGate();
        StoreController.gate = gate;
        const before = StoreController.calls.length;
        const aliceCall = ALICE.run(() =>
            client.callTool({ name: 'stores_pause', arguments: { query: 'hold' } }),
        );
        await gate.entered;

        const bobRefusal = await BOB.run(async () =>
            client.callTool({ name: 'stores_pause', arguments: { query: 'mine' } }).then(
                () => undefined,
                (error: Error) => error,
            ),
        );
        expect(bobRefusal?.message).toContain('Unknown tool: stores_pause');
        const bobList = await BOB.run(() =>
            client.callTool({ name: 'stores_list', arguments: { query: 'mine' } }),
        );
        expect(bobList.structuredContent).toEqual({ userId: 'bob', result: 'mine' });

        gate.open();
        const alice = await aliceCall;
        expect(alice.isError).not.toBe(true);
        expect(alice.structuredContent).toEqual({ userId: 'alice', result: 'hold' });
        // Exactly A's pause and B's list reached the controller; B's refused pause never did.
        expect(StoreController.calls.slice(before)).toEqual(['list', 'pause']);
        StoreController.gate = undefined;
    });

    it('serves only the toolset profile: an admin-profile tool is absent even for an OPERATOR', async () => {
        const names = await ALICE.run(async () => toolNames(await client.listTools()));
        expect(names).not.toContain('stores_purge');
    });

    it('refuses to build a toolset whose @WpMcpTool is SERVICE_ONLY, which no model call may satisfy', () => {
        expect(
            () =>
                new McpToolset(
                    [McpApiBinding.local(ServiceOnlyToolApi, router)],
                    [],
                    router.authorizationService(),
                    [Mcp.DEFAULT],
                ),
        ).toThrow(/ServiceOnlyToolApi\.run declares @WpAuthorization SERVICE_ONLY/);
    });

    it('refuses a call made outside any RequestContext instead of running it as nobody', async () => {
        await expect(client.listTools()).rejects.toThrow(/Internal Error/);
    });

    it('McpClientSet.merge routes by name across clients and refuses a duplicate tool name', async () => {
        const profiles = await WpMcpInMemory.connect(
            new McpToolset(
                [McpApiBinding.local(ProfileApi, router)],
                [PROFILE_CATALOG],
                router.authorizationService(),
                ['course-authoring'],
            ),
        );
        const merged = await ALICE.run(() => McpClientSet.merge([client, profiles]));
        const names = await ALICE.run(async () =>
            (await merged.listTools()).map((tool: { name: string }) => tool.name),
        );
        expect(names).toEqual(['stores_list', 'stores_pause', 'course']);
        const routed = await ALICE.run(() =>
            merged.callTool({ name: 'course', arguments: { query: 'lesson' } }),
        );
        expect(routed.structuredContent).toEqual({ userId: 'profile', result: 'lesson' });

        const twin = await WpMcpInMemory.connect(
            new McpToolset(
                [McpApiBinding.local(StoreApi, router)],
                [STORE_CATALOG],
                router.authorizationService(),
                ['user'],
            ),
        );
        await expect(ALICE.run(() => McpClientSet.merge([client, twin]))).rejects.toThrow(
            McpDuplicateToolError,
        );
        await expect(ALICE.run(() => McpClientSet.merge([client, twin]))).rejects.toThrow(
            "MCP tool 'stores_list' is published by client #0 and client #1",
        );
    });
});
