import 'reflect-metadata';
import { createServer, Server } from 'node:http';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeaderRegistry } from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouter, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { VerifiedMcpCredential, WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import { LegacyMcpHttpTestHarness } from './__tests__/LegacyMcpHttpTestHarness';
import { McpHttpTestHarness } from './__tests__/McpHttpTestHarness';
import {
    ENDPOINT_PATH,
    LEGACY_VERSION,
    OLDER_LEGACY_VERSION,
    SearchApi,
    SEARCH_API_CATALOG,
    SearchController,
    TestJwtHook,
    TestTokenAuthority,
    UNKNOWN_VERSION,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

/**
 * One endpoint, both MCP wire eras (issue #969). These specs exist because the bridge once pinned
 * 2026-07-28 and answered `-32022 Unsupported protocol version` to every shipping client, which
 * speaks the 2025 family — so each one here asserts the NEGOTIATED outcome, and the last asserts
 * that a revision no era knows is still refused.
 */
describe('WpMcpServer protocol negotiation', () => {
    let bridge: WpMcpServer<string, string>;
    let httpServer: Server;
    let baseUrl: string;
    let legacy: LegacyMcpHttpTestHarness;
    let modern: McpHttpTestHarness;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        const jwtHook = new TestJwtHook();
        const module = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        const router: WebpiecesRouter = await WebpiecesRouterFactory.create({
            appBindings: [module],
        });
        router.addRoutes(SearchApi, SearchController);
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string, string>()
                .setName('test-server')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/app-owned/mcp')
                .setAccessTokenAuthority(new TestTokenAuthority())
                .setEndpointJwtAuthority(jwtHook)
                .setEndpointMintRequest((credential: VerifiedMcpCredential) => credential.subject)
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']),
        );
        const app: Express = express();
        bridge.bind(
            app,
            new McpBindOptions(
                ENDPOINT_PATH,
                [McpApiBinding.local(SearchApi, router)],
                [SEARCH_API_CATALOG],
                McpDeployment.singleProcess(),
            ),
        );
        httpServer = createServer(app);
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            httpServer.once('error', reject);
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        const address = httpServer.address();
        if (!address || typeof address === 'string') throw new Error('test server has no port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        legacy = new LegacyMcpHttpTestHarness(baseUrl, ENDPOINT_PATH);
        modern = new McpHttpTestHarness(baseUrl, ENDPOINT_PATH);
    });

    afterAll(async () => {
        await bridge.close();
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            httpServer.close((error?: Error) => (error ? reject(error) : resolve()));
        });
    });

    it.each([LEGACY_VERSION, OLDER_LEGACY_VERSION])(
        'negotiates a 2025-era initialize asking for %s instead of refusing it',
        async (requested: string) => {
            const reply = await legacy.post(legacy.initialize(requested));
            expect(reply.response.status).toBe(200);
            const result = legacy.resultOf(reply.payload);
            expect(result['protocolVersion']).toBe(requested);
            expect(result['serverInfo']).toMatchObject({ name: 'test-server' });
        },
    );

    it('still serves the modern era from the same endpoint', async () => {
        const reply = await modern.post(modern.request('tools/list'));
        expect(reply.response.status).toBe(200);
        const tools = modern.resultOf(reply.payload)['tools'] as Array<Record<string, unknown>>;
        expect(tools.map((tool: Record<string, unknown>) => String(tool['name']))).toContain(
            'account_search',
        );
    });

    it('lists and calls the same tools over the 2025-era wire', async () => {
        const handshake = await legacy.post(legacy.initialize(LEGACY_VERSION));
        const negotiated = String(legacy.resultOf(handshake.payload)['protocolVersion']);
        const listed = await legacy.post(legacy.request('tools/list'), 'mcp-user', negotiated);
        const tools = legacy.resultOf(listed.payload)['tools'] as Array<Record<string, unknown>>;
        expect(tools.map((tool: Record<string, unknown>) => String(tool['name']))).toContain(
            'account_search',
        );
        const called = await legacy.post(
            legacy.request('tools/call', {
                name: 'account_search',
                arguments: { query: 'mine' },
            }),
            'mcp-user',
            negotiated,
        );
        const result = legacy.resultOf(called.payload);
        expect(result['isError']).toBeFalsy();
        expect(result['structuredContent']).toMatchObject({ userId: 'user-7', result: 'mine' });
    });

    it('reports controller progress over the 2025-era wire too', async () => {
        // A 2025 progressToken lives in params._meta WITHOUT a protocol-version claim, so this also
        // pins that `hasProgressToken` routing to the streaming handler never modernises a request.
        const body = legacy.request('tools/call', {
            name: 'account_search',
            arguments: { query: 'progress' },
            _meta: { progressToken: 'legacy-progress' },
        });
        const response = await fetch(`${baseUrl}${ENDPOINT_PATH}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer mcp-user',
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                'mcp-protocol-version': LEGACY_VERSION,
            },
            body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        const stream = await response.text();
        expect(stream).toContain('notifications/progress');
        expect(stream).toContain('"progressToken":"legacy-progress"');
        expect(stream).toContain('"result":"progress"');
    });

    it('still verifies the bind boundary bearer on the 2025-era wire', async () => {
        const anonymous = await legacy.post(legacy.initialize(LEGACY_VERSION), null);
        expect(anonymous.response.status).toBe(401);
        expect(anonymous.response.headers.get('www-authenticate')).toContain('resource_metadata=');
        const rejected = await legacy.post(legacy.initialize(LEGACY_VERSION), 'invalid');
        expect(rejected.response.status).toBe(401);
        const expired = await legacy.post(legacy.initialize(LEGACY_VERSION), 'expired');
        expect(expired.response.status).toBe(401);
    });

    it.each(['GET', 'DELETE'])(
        'answers a 2025 session %s with 405, as the stateless legacy leg does',
        async (method: string) => {
            const response = await fetch(`${baseUrl}${ENDPOINT_PATH}`, { method });
            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('POST');
        },
    );

    it('refuses a revision no era knows, naming what it does serve', async () => {
        const reply = await modern.post(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {
                    _meta: {
                        [PROTOCOL_VERSION_META_KEY]: UNKNOWN_VERSION,
                        [CLIENT_INFO_META_KEY]: { name: 'from-the-future', version: '1' },
                        [CLIENT_CAPABILITIES_META_KEY]: {},
                    },
                },
            },
            'mcp-user',
            { 'mcp-protocol-version': UNKNOWN_VERSION },
        );
        expect(reply.payload.error?.code).toBe(-32_022);
        expect(reply.payload.error?.data?.['requested']).toBe(UNKNOWN_VERSION);
    });
});
