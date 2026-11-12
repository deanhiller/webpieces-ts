import 'reflect-metadata';
import { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeaderRegistry, oidcSameProject, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { JWT_HOOK, OIDC_HOOK, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpToolset } from './McpToolset';
import { McpApprovalHooks } from './McpApproval';
import { WpMcpRemote, McpIdTokenMinter, WpMcpRemoteOptions } from './WpMcpRemote';
import { WpMcpServer } from './WpMcpServer';
import { TestServers } from './__tests__/McpHttpTestHarness';
import {
    DevOidcTokens,
    ProjectOidcHook,
    SAME_PROJECT_SA,
    STORE_CATALOG,
    StoreApi,
    StoreController,
    TransportJwtHook,
    VerifiedCaller,
} from './__tests__/McpTransportFixtures';

/** The OIDC minting edge: a dev token for this project's service account, every audience recorded. */
class RecordingMinter implements McpIdTokenMinter {
    readonly audiences: string[] = [];

    async mintIdToken(audience: string): Promise<string> {
        this.audiences.push(audience);
        return DevOidcTokens.of(SAME_PROJECT_SA, audience);
    }
}

function toolNames(list: { tools: Array<{ name: string }> }): string[] {
    return list.tools.map((tool: { name: string }) => tool.name);
}

/**
 * WpMcpRemote (#1416): an MCP SDK client whose transport mints OIDC and forwards the CURRENT
 * RequestContext's trusted keys PER POST, so the callee's @WpAuthorization judges the user on whose
 * behalf each call is made — through one cached client.
 */
describe('WpMcpRemote over an oidcSameProject() MCP door, end to end', () => {
    let http: Server;
    let callee: WpMcpServer;
    let client: Client;
    let minter: RecordingMinter;
    let url: string;

    beforeAll(async () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TransportJwtHook());
                    options.bind(OIDC_HOOK).toConstantValue(new ProjectOidcHook());
                }),
            ],
        });
        router.addRoutes(StoreApi, StoreController);
        callee = new WpMcpServer(
            new WpMcpServerConfig()
                .setName('svc-b')
                .setTitle('Service B')
                .setDescription('The callee of an internal MCP hop.')
                .setWebsiteUrl('https://docs.example.test/mcp')
                .setVersion('1.0.0')
                .setResource('https://svc-b.example.test/mcp/user')
                .setAuth([oidcSameProject()])
                .setCredentialVerifiers(router.credentialVerifiers()),
            new McpToolset(
                [McpApiBinding.local(StoreApi, router)],
                [STORE_CATALOG],
                router.authorizationService(),
                ['user'],
            ),
        );
        const app = express();
        callee.bind(app, new McpBindOptions('/mcp/user', McpDeployment.singleProcess()));
        http = await TestServers.listen(app);
        url = `${TestServers.urlOf(http)}/mcp/user`;
        minter = new RecordingMinter();
        client = await WpMcpRemote.connect(
            url,
            oidcSameProject(),
            minter,
            new WpMcpRemoteOptions(McpApprovalHooks.ALLOW_ALL),
        );
    });

    afterAll(async () => {
        await client.close();
        await callee.close();
        await TestServers.close(http);
    });

    it("carries each caller's identity to the callee's @WpAuthorization through one cached client", async () => {
        const alice = new VerifiedCaller('alice', ['OPERATOR']);
        const bob = new VerifiedCaller('bob', []);
        expect(await alice.run(async () => toolNames(await client.listTools()))).toEqual([
            'stores_list',
            'stores_pause',
        ]);
        expect(await bob.run(async () => toolNames(await client.listTools()))).toEqual([
            'stores_list',
        ]);

        const paused = await alice.run(() =>
            client.callTool({ name: 'stores_pause', arguments: { query: 'remote' } }),
        );
        expect(paused.structuredContent).toEqual({ userId: 'alice', result: 'remote' });
        const refused = await bob.run(() =>
            client.callTool({ name: 'stores_pause', arguments: { query: 'remote' } }).then(
                () => undefined,
                (error: Error) => error,
            ),
        );
        expect(refused?.message).toContain('Unknown tool: stores_pause');
    });

    it('mints a fresh OIDC token for the callee origin on every POST', async () => {
        const before = minter.audiences.length;
        await new VerifiedCaller('alice', ['OPERATOR']).run(() => client.listTools());
        expect(minter.audiences.length).toBeGreaterThan(before);
        expect(new Set(minter.audiences)).toEqual(new Set([new URL(url).origin]));
    });
});
