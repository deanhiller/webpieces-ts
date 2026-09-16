import 'reflect-metadata';
import { createServer, request as nodeRequest, Server } from 'node:http';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryServerEventBus,
    PROTOCOL_VERSION_META_KEY,
    ServerEvent,
    ServerEventBus,
} from '@modelcontextprotocol/server';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiPath,
    Endpoint,
    HeaderRegistry,
    WpAuthJwt,
    WpMcpTool,
    WpResponseDto,
} from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouter, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { VerifiedMcpCredential, WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import { McpHttpTestHarness, McpPostReply, RpcResponse } from './__tests__/McpHttpTestHarness';
import {
    ENDPOINT_PATH,
    MODERN_VERSION,
    RemoteSearchApi,
    RemoteSearchClient,
    SearchApi,
    SearchController,
    SearchRequest,
    SearchResponse,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

class SharedTestEventBus implements ServerEventBus {
    private readonly listeners = new Set<(event: ServerEvent) => void>();

    publish(event: ServerEvent): void {
        for (const listener of this.listeners) listener(event);
    }

    subscribe(listener: (event: ServerEvent) => void): () => void {
        this.listeners.add(listener);
        return (): void => {
            this.listeners.delete(listener);
        };
    }
}

interface BoundTestBridge {
    bridge: WpMcpServer<string, string>;
    server: Server;
    url: string;
}

describe('WpMcpServer modern HTTP bridge', () => {
    let bridge: WpMcpServer<string, string>;
    let controller: SearchController;
    let authority: TestTokenAuthority;
    let jwtHook: TestJwtHook;
    let remote: RemoteSearchClient;
    let router: WebpiecesRouter;
    let httpServer: Server;
    let baseUrl: string;
    let harness: McpHttpTestHarness;
    let nextId = 10_000;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        jwtHook = new TestJwtHook();
        const module = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        router = await WebpiecesRouterFactory.create({ appBindings: [module] });
        router.addRoutes(SearchApi, SearchController);
        controller = router.getContainer().get(SearchController);
        authority = new TestTokenAuthority();
        remote = new RemoteSearchClient();
        bridge = new WpMcpServer(serverConfig());
        const app: Express = express();
        bridge.bind(
            app,
            new McpBindOptions(
                ENDPOINT_PATH,
                [
                    McpApiBinding.local(SearchApi, router),
                    McpApiBinding.remote(RemoteSearchApi, () => remote),
                ],
                McpDeployment.singleProcess(1_234),
                ['https://trusted.example.test'],
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
        harness = new McpHttpTestHarness(baseUrl, ENDPOINT_PATH);
    });

    afterAll(async () => {
        await bridge.close();
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            httpServer.close((error?: Error) => (error ? reject(error) : resolve()));
        });
    });

    function serverConfig(): WpMcpServerConfig<string, string> {
        return new WpMcpServerConfig(
            'test-server',
            '1.0.0',
            'https://api.example.test/mcp',
            authority,
            jwtHook,
            (credential: VerifiedMcpCredential) => credential.subject,
            ['https://login.example.test'],
            ['tools'],
        );
    }

    async function bindTestBridge(
        deployment: McpDeployment,
        bindings: McpApiBinding[] = [McpApiBinding.local(SearchApi, router)],
    ): Promise<BoundTestBridge> {
        const instance = new WpMcpServer<string, string>(serverConfig());
        const app: Express = express();
        instance.bind(app, new McpBindOptions(ENDPOINT_PATH, bindings, deployment));
        const server = createServer(app);
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('distributed test server has no port');
        return { bridge: instance, server, url: `http://127.0.0.1:${address.port}` };
    }

    async function closeTestServer(server: Server): Promise<void> {
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            server.close((error?: Error) => (error ? reject(error) : resolve()));
        });
    }

    function request(
        method: string,
        params: Record<string, unknown> = {},
    ): Record<string, unknown> {
        return harness.request(method, params);
    }

    async function post(
        body: Record<string, unknown>,
        token = 'mcp-user',
        extraHeaders: Record<string, string> = {},
        path = ENDPOINT_PATH,
    ): Promise<McpPostReply> {
        return harness.post(body, token, extraHeaders, path);
    }

    async function callTool(
        name: string,
        args: Record<string, unknown>,
        token = 'mcp-user',
    ): Promise<RpcResponse> {
        return harness.callTool(name, args, token);
    }

    function resultOf(payload: RpcResponse): Record<string, unknown> {
        return harness.resultOf(payload);
    }

    function structuredOf(payload: RpcResponse): Record<string, unknown> {
        return harness.structuredOf(payload);
    }

    function modelErrorOf(payload: RpcResponse): Record<string, unknown> {
        return harness.modelErrorOf(payload);
    }

    it('uses the app path, modern envelope, schemas, cache hints, and a stable revision', async () => {
        const reply = await post(request('tools/list'));
        expect(reply.response.status).toBe(200);
        expect(reply.response.headers.get('x-accel-buffering')).toBe('no');
        const result = resultOf(reply.payload);
        expect(result).toMatchObject({
            resultType: 'complete',
            ttlMs: 1_234,
            cacheScope: 'private',
        });
        const tools = result['tools'] as Array<Record<string, unknown>>;
        expect(tools.map((tool: Record<string, unknown>) => tool['name'])).toEqual([
            'account_search',
            'remote_search',
        ]);
        expect(tools[0]).toMatchObject({
            inputSchema: { required: ['query'], properties: { query: { type: 'string' } } },
            outputSchema: { required: ['userId', 'result'] },
        });
        expect(bridge.registryRevision).toMatch(/^[a-f0-9]{12}$/);
        // The client only ever sees the one MCP endpoint, never a downstream Webpieces route.
        expect(JSON.stringify(tools)).not.toContain('/mcp-spec');
        expect(JSON.stringify(tools)).not.toContain('/remote-spec');
        expect((await post(request('tools/list'), 'mcp-user', {}, '/mcp')).response.status).toBe(
            404,
        );
    });

    it('opens request-scoped SSE for subscriptions and distributes tool invalidation', async () => {
        const body = request('subscriptions/listen', { notifications: { toolsListChanged: true } });
        const abort = new AbortController();
        const response = await fetch(`${baseUrl}${ENDPOINT_PATH}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer mcp-user',
                accept: 'text/event-stream',
                'content-type': 'application/json',
                'mcp-protocol-version': MODERN_VERSION,
                'mcp-method': 'subscriptions/listen',
            },
            body: JSON.stringify(body),
            signal: abort.signal,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('subscription response has no body');
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain(
            'notifications/subscriptions/acknowledged',
        );
        bridge.toolsChanged();
        const second = await reader.read();
        expect(new TextDecoder().decode(second.value)).toContain(
            'notifications/tools/list_changed',
        );
        abort.abort();
    });

    it('uses a shared distributed bus across servers and close terminates an active listener', async () => {
        expect(() => McpDeployment.distributed(new InMemoryServerEventBus())).toThrow(
            /cannot use InMemoryServerEventBus/,
        );
        const bus = new SharedTestEventBus();
        const first = await bindTestBridge(McpDeployment.distributed(bus));
        const second = await bindTestBridge(McpDeployment.distributed(bus));
        const body = request('subscriptions/listen', { notifications: { toolsListChanged: true } });
        const response = await fetch(`${first.url}${ENDPOINT_PATH}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer mcp-user',
                accept: 'text/event-stream',
                'content-type': 'application/json',
                'mcp-protocol-version': MODERN_VERSION,
                'mcp-method': 'subscriptions/listen',
            },
            body: JSON.stringify(body),
        });
        const reader = response.body?.getReader();
        if (!reader) throw new Error('distributed subscription has no response body');
        const acknowledged = await reader.read();
        expect(new TextDecoder().decode(acknowledged.value)).toContain(
            'notifications/subscriptions/acknowledged',
        );
        second.bridge.toolsChanged();
        const changed = await reader.read();
        expect(new TextDecoder().decode(changed.value)).toContain(
            'notifications/tools/list_changed',
        );
        await first.bridge.close();
        const closed = await reader.read();
        const closeText = new TextDecoder().decode(closed.value);
        expect(closed.done || closeText.includes('"resultType":"complete"')).toBe(true);
        await second.bridge.close();
        await closeTestServer(first.server);
        await closeTestServer(second.server);
    });

    it('re-listens after a rolling deploy and refreshes added and removed tools authoritatively', async () => {
        const bus = new SharedTestEventBus();
        const oldInstance = await bindTestBridge(McpDeployment.distributed(bus));
        const oldClient = new McpHttpTestHarness(oldInstance.url, ENDPOINT_PATH);
        const oldListen = await oldClient.openListen();
        expect(await oldClient.readText(oldListen)).toContain(
            'notifications/subscriptions/acknowledged',
        );
        expect(await oldClient.toolNames()).not.toContain('remote_search');

        await oldInstance.bridge.close();
        const drained = await oldListen.read();
        const drainedText = drained.done ? '' : new TextDecoder().decode(drained.value);
        expect(drained.done || drainedText.includes('"resultType":"complete"')).toBe(true);

        const added = await bindTestBridge(McpDeployment.distributed(bus), [
            McpApiBinding.local(SearchApi, router),
            McpApiBinding.remote(RemoteSearchApi, () => remote),
        ]);
        expect(added.bridge.registryRevision).not.toBe(oldInstance.bridge.registryRevision);
        const addedClient = new McpHttpTestHarness(added.url, ENDPOINT_PATH);
        const relisten = await addedClient.openListen();
        expect(await addedClient.readText(relisten)).toContain(
            'notifications/subscriptions/acknowledged',
        );
        expect(await addedClient.toolNames()).toContain('remote_search');

        const removed = await bindTestBridge(McpDeployment.distributed(bus), [
            McpApiBinding.remote(RemoteSearchApi, () => remote),
        ]);
        const removedClient = new McpHttpTestHarness(removed.url, ENDPOINT_PATH);
        expect(await removedClient.toolNames()).not.toContain('account_search');
        const stale = await removedClient.post(
            removedClient.request('tools/call', {
                name: 'account_search',
                arguments: { query: 'mine' },
            }),
        );
        expect(stale.payload.error).toMatchObject({
            code: -32_602,
            message: 'Unknown tool: account_search',
        });

        await relisten.cancel();
        await added.bridge.close();
        await removed.bridge.close();
        await closeTestServer(oldInstance.server);
        await closeTestServer(added.server);
        await closeTestServer(removed.server);
    });

    it('streams controller progress and a terminal result with the caller id and progress token', async () => {
        const body = request('tools/call', {
            name: 'account_search',
            arguments: { query: 'progress' },
        });
        const id = body['id'];
        const params = body['params'] as Record<string, unknown>;
        const metadata = params['_meta'] as Record<string, unknown>;
        metadata['progressToken'] = 'caller-progress';
        const response = await fetch(`${baseUrl}${ENDPOINT_PATH}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer mcp-user',
                accept: 'text/event-stream',
                'content-type': 'application/json',
                'mcp-protocol-version': MODERN_VERSION,
                'mcp-method': 'tools/call',
                'mcp-name': 'account_search',
                'mcp-param-query': 'progress',
            },
            body: JSON.stringify(body),
        });
        const stream = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(stream).toContain('notifications/progress');
        expect(stream).toContain('"progressToken":"caller-progress"');
        expect(stream).toContain('"progress":1');
        expect(stream).toContain('"total":2');
        expect(stream).toContain('halfway');
        expect(stream).toContain(`"id":${String(id)}`);
        expect(stream).toContain('"result":"progress"');
    });

    it('propagates client response cancellation into the controller invocation signal', async () => {
        let markStarted: (() => void) | undefined;
        let markAborted: (() => void) | undefined;
        const started = new Promise<void>((resolve: () => void) => {
            markStarted = resolve;
        });
        const aborted = new Promise<void>((resolve: () => void) => {
            markAborted = resolve;
        });
        SearchController.waitStartedHook = (): void => markStarted?.();
        SearchController.waitAbortedHook = (): void => markAborted?.();
        const body = request('tools/call', {
            name: 'account_search',
            arguments: { query: 'wait' },
        });
        const params = body['params'] as Record<string, unknown>;
        const metadata = params['_meta'] as Record<string, unknown>;
        metadata['progressToken'] = 'cancel-progress';
        const abort = new AbortController();
        const progressRead = new Promise<void>(
            (resolve: () => void, reject: (error: Error) => void) => {
                const clientRequest = nodeRequest(
                    `${baseUrl}${ENDPOINT_PATH}`,
                    {
                        method: 'POST',
                        signal: abort.signal,
                        headers: {
                            authorization: 'Bearer mcp-user',
                            accept: 'text/event-stream',
                            'content-type': 'application/json',
                            'mcp-protocol-version': MODERN_VERSION,
                            'mcp-method': 'tools/call',
                            'mcp-name': 'account_search',
                            'mcp-param-query': 'wait',
                        },
                    },
                    (response): void => {
                        response.once('data', (_chunk: Buffer): void => {
                            abort.abort();
                            response.destroy();
                            clientRequest.destroy();
                            resolve();
                        });
                    },
                );
                clientRequest.once('error', (error: Error): void => {
                    if (error.name !== 'AbortError') reject(error);
                });
                clientRequest.end(JSON.stringify(body));
            },
        );
        await started;
        await progressRead;
        await aborted;
        expect(abort.signal.aborted).toBe(true);
        SearchController.waitStartedHook = undefined;
        SearchController.waitAbortedHook = undefined;
    });

    it('runs the real local AuthFilter with a fresh endpoint JWT', async () => {
        expect(structuredOf(await callTool('account_search', { query: 'mine' }))).toEqual({
            userId: 'user-7',
            result: 'mine',
        });
        expect(structuredOf(await callTool('account_search', { query: 'again' }))).toEqual({
            userId: 'user-7',
            result: 'again',
        });
        expect(jwtHook.mintedTokens.at(-1)).not.toBe(jwtHook.mintedTokens.at(-2));
    });

    it('seeds remote trusted context without forwarding the MCP bearer token', async () => {
        expect(structuredOf(await callTool('remote_search', { query: 'remote' }))).toEqual({
            userId: 'user-delegated',
            result: 'remote',
        });
        expect(remote.seenAuthorization).toBeUndefined();
    });

    it('filters privileged tools but denies direct hidden calls independently', async () => {
        authority.roles = [];
        const listed = resultOf((await post(request('tools/list'))).payload)['tools'] as Array<
            Record<string, unknown>
        >;
        expect(listed.map((tool: Record<string, unknown>) => tool['name'])).not.toContain(
            'admin_search',
        );
        const hidden = await callTool('admin_search', { query: 'all' });
        expect(modelErrorOf(hidden)).toMatchObject({ kind: 'forbidden', message: 'Forbidden' });
        expect(controller.adminInvocations).toBe(0);
        authority.roles = ['admin'];
        const adminTools = resultOf((await post(request('tools/list'))).payload)['tools'] as Array<
            Record<string, unknown>
        >;
        expect(adminTools.map((tool: Record<string, unknown>) => tool['name'])).toContain(
            'admin_search',
        );
        authority.roles = [];
    });

    it('authenticates every operation and validates Origin', async () => {
        for (const rejected of [
            'invalid',
            'wrong-resource',
            'wrong-issuer',
            'expired',
            'missing-scope',
            'stale-account',
        ]) {
            expect((await post(request('tools/list'), rejected)).response.status).toBe(401);
        }
        expect(
            (
                await post(request('tools/list'), 'mcp-user', {
                    origin: 'https://trusted.example.test',
                })
            ).response.status,
        ).toBe(200);
        const denied = await post(request('tools/list'), 'mcp-user', {
            origin: 'https://evil.example.test',
        });
        expect(denied.response.status).toBe(403);
        expect(denied.payload.error?.message).toBe('Forbidden');
    });

    it('uses exact HTTP and JSON-RPC errors for legacy, unknown methods, and header mismatches', async () => {
        expect((await fetch(`${baseUrl}${ENDPOINT_PATH}`)).status).toBe(404);
        const legacy = await post({
            jsonrpc: '2.0',
            id: ++nextId,
            method: 'initialize',
            params: {
                protocolVersion: '2025-03-26',
                clientInfo: { name: 'old', version: '1' },
                capabilities: {},
            },
        });
        expect(legacy.response.status).toBe(400);
        expect(legacy.payload.error).toBeDefined();
        const mismatch = await post(request('tools/list'), 'mcp-user', {
            'mcp-protocol-version': '2025-11-25',
        });
        expect(mismatch.response.status).toBe(400);
        expect(mismatch.payload.error?.code).toBe(-32_020);
        const unknown = await post(request('unknown/method'));
        expect(unknown.response.status).toBe(404);
        expect(unknown.payload.error?.code).toBe(-32_601);
        const nameMismatch = await post(
            request('tools/call', { name: 'account_search', arguments: { query: 'mine' } }),
            'mcp-user',
            { 'mcp-name': 'different_tool' },
        );
        expect(nameMismatch.response.status).toBe(400);
        expect(nameMismatch.payload.error?.code).toBe(-32_020);
        const paramMismatch = await post(
            request('tools/call', { name: 'account_search', arguments: { query: 'mine' } }),
            'mcp-user',
            { 'mcp-param-query': 'different-query' },
        );
        expect(paramMismatch.response.status).toBe(400);
        expect(paramMismatch.payload.error?.code).toBe(-32_020);
    });

    it('requires MCP auth metadata and topology-compatible HTTP auth at startup', () => {
        @ApiPath('/invalid')
        class MissingMcpAuthApi {
            @WpAuthJwt({ allRolesAllowed: true })
            @Endpoint('/tool', 'rpc')
            @WpResponseDto(() => SearchResponse)
            @WpMcpTool({ name: 'missing_mcp_auth', description: 'invalid' })
            tool(_request: SearchRequest): Promise<SearchResponse> {
                throw new Error('contract only');
            }
        }
        const missing = new WpMcpServer(serverConfig());
        expect(() =>
            missing.bind(
                express(),
                new McpBindOptions(
                    '/invalid-one',
                    [McpApiBinding.local(MissingMcpAuthApi, router)],
                    McpDeployment.singleProcess(),
                ),
            ),
        ).toThrow(/must declare @WpMcpAuthJwt/);
        const mismatch = new WpMcpServer(serverConfig());
        expect(() =>
            mismatch.bind(
                express(),
                new McpBindOptions(
                    '/invalid-two',
                    [McpApiBinding.remote(SearchApi, () => new SearchController())],
                    McpDeployment.singleProcess(),
                ),
            ),
        ).toThrow(/requires @WpAuthOidc/);
    });

    it('exposes resource metadata, invalidates tools, and refuses token passthrough', async () => {
        expect(bridge.protectedResourceMetadata()).toMatchObject({
            resource: 'https://api.example.test/mcp',
            authorization_servers: ['https://login.example.test'],
            scopes_supported: ['tools'],
        });
        expect(() => bridge.toolsChanged()).not.toThrow();
        expect(
            modelErrorOf(await callTool('account_search', { query: 'mine' }, 'mcp-passthrough')),
        ).toMatchObject({
            kind: 'implementation',
        });
        jwtHook.lifetimeSeconds = 3_601;
        expect(modelErrorOf(await callTool('account_search', { query: 'mine' }))).toMatchObject({
            kind: 'implementation',
        });
        jwtHook.lifetimeSeconds = 60;
    });
});
