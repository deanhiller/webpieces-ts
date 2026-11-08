import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { type Server } from 'node:http';
import { ContainerModule, type ContainerModuleLoadOptions } from 'inversify';
import {
    HeaderRegistry,
    ServiceInfo,
    LogManager,
    ConsoleLoggerFactory,
} from '@webpieces/core-util';
import {
    JWT_HOOK,
    LazyController,
    LazyImplementation,
    ApplicationImplementation,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import { McpHttpTestHarness, TestServers } from './__tests__/McpHttpTestHarness';
import {
    ENDPOINT_PATH,
    SearchApi,
    SearchController,
    SEARCH_API_CATALOG,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

class LazyMcpApp {
    constructor(private readonly mode: 'isolated' | 'application') {}
    bridge?: WpMcpServer<string>;
    server?: Server;
    harness!: McpHttpTestHarness;
    imports = 0;
    async boot(): Promise<void> {
        ServiceInfo.setInfo('lazy-mcp-test', 'test');
        HeaderRegistry.configure([USER_ID], true);
        LogManager.setFactory(new ConsoleLoggerFactory());
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TestJwtHook());
                }),
            ],
        });
        router.addRoutes(
            SearchApi,
            new LazyController('SearchController', '**/SearchController.ts', 1000, async () => {
                this.imports++;
                return this.mode === 'application'
                    ? new ApplicationImplementation(SearchController)
                    : new LazyImplementation(SearchController, [], [], []);
            }),
        );
        this.bridge = new WpMcpServer(
            new WpMcpServerConfig<string>()
                .setName('lazy-mcp-spec')
                .setTitle('Lazy MCP test')
                .setDescription('First-use routing through verified MCP dispatch')
                .setWebsiteUrl('https://docs.example.test/mcp')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/app-owned/mcp')
                .setAccessTokenAuthority(new TestTokenAuthority())
                .setAuthorizationService(router.authorizationService())
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']),
        );
        const app = express();
        this.bridge.bind(
            app,
            new McpBindOptions(
                ENDPOINT_PATH,
                [McpApiBinding.local(SearchApi, router)],
                [SEARCH_API_CATALOG],
                McpDeployment.singleProcess(),
            ),
        );
        this.server = await TestServers.listen(app);
        this.harness = new McpHttpTestHarness(TestServers.urlOf(this.server), ENDPOINT_PATH);
    }
    async close(): Promise<void> {
        await this.bridge?.close();
        if (this.server) await TestServers.close(this.server);
    }
}

for (const mode of ['isolated', 'application'] as const) {
    describe(`first-use controller through real MCP dispatch (${mode})`, () => {
        const app = new LazyMcpApp(mode);
        afterEach(async () => app.close());
        it('discovers tools without loading, rejects a denied call, then preserves each permitted principal', async () => {
            await app.boot();
            const list = await app.harness.post(app.harness.request('tools/list'), 'mcp-admin');
            expect(JSON.stringify(list.payload)).toContain('admin_search');
            expect(app.imports).toBe(0);
            const denied = await app.harness.callTool(
                'admin_search',
                { query: 'denied' },
                'mcp-user',
            );
            expect(denied.error).toMatchObject({
                code: -32602,
                message: 'Unknown tool: admin_search',
            });
            expect(app.imports).toBe(0);
            const admin = await app.harness.callTool(
                'admin_search',
                { query: 'first-admin' },
                'mcp-admin',
            );
            expect(app.harness.structuredOf(admin)).toMatchObject({
                userId: 'admin-7',
                result: 'first-admin',
            });
            const learner = await app.harness.callTool(
                'account_search',
                { query: 'later-user' },
                'mcp-user',
            );
            expect(app.harness.structuredOf(learner)).toMatchObject({
                userId: 'user-7',
                result: 'later-user',
            });
            expect(app.imports).toBe(1);
        });
    });
}
