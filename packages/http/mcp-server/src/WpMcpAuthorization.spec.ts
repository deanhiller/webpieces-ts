import 'reflect-metadata';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiForbiddenError, HeaderRegistry, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import {
    AuthenticatedCaller,
    AUTHENTICATED_CALLER_KEY,
    JWT_HOOK,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { VerifiedMcpCredential, WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import {
    McpHttpTestHarness,
    McpPostReply,
    RpcResponse,
    TestServers,
} from './__tests__/McpHttpTestHarness';
import { LegacyMcpHttpTestHarness } from './__tests__/LegacyMcpHttpTestHarness';
import {
    ENDPOINT_PATH,
    MODERN_VERSION,
    LEGACY_VERSION,
    RemoteSearchApi,
    RemoteSearchClient,
    SearchApi,
    SearchController,
    REMOTE_SEARCH_API_CATALOG,
    SEARCH_API_CATALOG,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

describe('MCP principal authorization and one transport context', () => {
    let bridge: WpMcpServer<string, string>;
    let httpServer: Server;
    let controller: SearchController;
    let jwtHook: TestJwtHook;
    let authority: TestTokenAuthority;
    let harness: McpHttpTestHarness;
    let baseUrl: string;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        jwtHook = new TestJwtHook();
        authority = new TestTokenAuthority();
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        const router = await WebpiecesRouterFactory.create({ appBindings: [bindings] });
        router.addRoutes(SearchApi, SearchController);
        controller = router.getContainer().get(SearchController);
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string, string>()
                .setName('authorization-spec')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/app-owned/mcp')
                .setAccessTokenAuthority(authority)
                .setEndpointJwtAuthority(jwtHook)
                .setEndpointMintRequest((credential: VerifiedMcpCredential) => credential.subject)
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']),
        );
        const app = express();
        bridge.bind(
            app,
            new McpBindOptions(
                ENDPOINT_PATH,
                [
                    McpApiBinding.local(SearchApi, router),
                    McpApiBinding.remote(RemoteSearchApi, () => new RemoteSearchClient()),
                ],
                [SEARCH_API_CATALOG, REMOTE_SEARCH_API_CATALOG],
                McpDeployment.singleProcess(),
            ),
        );
        httpServer = await TestServers.listen(app);
        baseUrl = TestServers.urlOf(httpServer);
        harness = new McpHttpTestHarness(baseUrl, ENDPOINT_PATH);
    });

    afterAll(async () => {
        await bridge.close();
        await TestServers.close(httpServer);
    });

    function request(
        method: string,
        params: Record<string, unknown> = {},
    ): Record<string, unknown> {
        return harness.request(method, params);
    }
    async function post(
        body: Record<string, unknown>,
        token = 'mcp-user',
        headers: Record<string, string> = {},
    ): Promise<McpPostReply> {
        return harness.post(body, token, headers);
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

    it.each([MODERN_VERSION, LEGACY_VERSION])(
        'hidden body/header probes are unknown with no side effects in %s',
        async (version) => {
            authority.roles = [];
            const minted = jwtHook.mintedTokens.length;
            const invoked = controller.adminInvocations;
            const legacy = new LegacyMcpHttpTestHarness(baseUrl, ENDPOINT_PATH);
            for (const args of [
                {},
                { query: 'all' },
                { query: 7 },
                { query: 'all', injected: true },
            ]) {
                const wire = version === MODERN_VERSION ? harness : legacy;
                const hiddenRequest = wire.request('tools/call', {
                    name: 'admin_search',
                    arguments: args,
                });
                const missingRequest = wire.request('tools/call', {
                    name: 'missing_search',
                    arguments: args,
                });
                const hidden =
                    version === MODERN_VERSION
                        ? await harness.post(hiddenRequest, 'mcp-user', { 'mcp-param-query': '7' })
                        : await legacy.post(hiddenRequest, 'mcp-user', version);
                const missing =
                    version === MODERN_VERSION
                        ? await harness.post(missingRequest, 'mcp-user', { 'mcp-param-query': '7' })
                        : await legacy.post(missingRequest, 'mcp-user', version);
                expect(hidden.response.status).toBe(missing.response.status);
                expect(hidden.payload.error?.code).toBe(missing.payload.error?.code);
                expect(hidden.payload.error?.message).toBe('Unknown tool: admin_search');
                expect(JSON.stringify(hidden.payload)).not.toContain('$.query');
                expect(JSON.stringify(hidden.payload)).not.toContain('Search text');
            }
            expect(jwtHook.mintedTokens).toHaveLength(minted);
            expect(controller.adminInvocations).toBe(invoked);
            await callTool('account_search', {});
            expect(jwtHook.mintedTokens).toHaveLength(minted);
        },
    );

    it('publishes the principal before async policy and retains original context through endpoint auth', async () => {
        const original = jwtHook.authorizeJwt.bind(jwtHook);
        const originalParse = jwtHook.parseJwt.bind(jwtHook);
        const stages: string[] = [];
        let ingressRequest: object | undefined;
        jwtHook.authorizeJwt = async (caller, requirement) => {
            await Promise.resolve();
            expect(RequestContext.getTrusted(AUTHENTICATED_CALLER_KEY)?.userId).toBe('user-7');
            expect(RequestContext.getTrusted(WebpiecesCoreHeaders.SURFACE)).toBe('llm');
            expect(RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID)).toBe('scope-1080');
            expect(RequestContext.getUntrusted(WebpiecesCoreHeaders.ACTION_ID)).toBe('action-1080');
            expect(RequestContext.getRequest()?.path).toBe(ENDPOINT_PATH);
            if (!ingressRequest) ingressRequest = RequestContext.getRequest();
            expect(RequestContext.getRequest()).toBe(ingressRequest);
            stages.push('policy');
            await original(caller, requirement);
        };
        jwtHook.parseJwt = async (token) => {
            stages.push('endpoint-auth');
            expect(RequestContext.getRequest()).toBe(ingressRequest);
            expect(RequestContext.getTrusted(USER_ID)).toBe('user-7');
            return originalParse(token);
        };
        try {
            const reply = await post(
                request('tools/call', { name: 'account_search', arguments: { query: 'same' } }),
                'mcp-user',
                { 'x-request-id': 'scope-1080', 'x-webpieces-actionid': 'action-1080' },
            );
            expect(resultOf(reply.payload)['structuredContent']).toMatchObject({
                userId: 'user-7',
                result: 'same',
            });
            expect(stages).toContain('endpoint-auth');
            expect(RequestContext.isActive()).toBe(false);
        } finally {
            jwtHook.authorizeJwt = original;
            jwtHook.parseJwt = originalParse;
        }
    });

    it('uses app policy for visibility and rechecks it before validation or issuance', async () => {
        const original = jwtHook.authorizeJwt.bind(jwtHook);
        let checks = 0;
        jwtHook.authorizeJwt = async (_caller, _requirement) => {
            checks += 1;
            // Deny the dispatcher recheck after the three tools were projected.
            if (checks > 3) throw new ApiForbiddenError('SECRET-policy-denial');
        };
        const minted = jwtHook.mintedTokens.length;
        try {
            const reply = await callTool('admin_search', {});
            expect(reply.error).toMatchObject({
                code: -32602,
                message: 'Unknown tool: admin_search',
            });
            expect(JSON.stringify(reply)).not.toContain('SECRET');
            expect(JSON.stringify(reply)).not.toContain('$.query');
            expect(jwtHook.mintedTokens).toHaveLength(minted);
        } finally {
            jwtHook.authorizeJwt = original;
        }
    });

    it('enforces endpoint policy after MCP policy, and rejects a divergent minted identity', async () => {
        const original = jwtHook.authorizeJwt.bind(jwtHook);
        const parse = jwtHook.parseJwt.bind(jwtHook);
        let endpointChecked = false;
        jwtHook.authorizeJwt = async (caller, requirement) => {
            await original(caller, requirement);
            if (caller !== RequestContext.getTrusted(AUTHENTICATED_CALLER_KEY)) {
                endpointChecked = true;
                throw new ApiForbiddenError('endpoint-specific denial');
            }
        };
        try {
            expect(
                modelErrorOf(await callTool('account_search', { query: 'blocked' })),
            ).toMatchObject({ kind: 'forbidden' });
            expect(endpointChecked).toBe(true);
            jwtHook.authorizeJwt = original;
            jwtHook.parseJwt = async () => new AuthenticatedCaller('wrong-user');
            expect(
                modelErrorOf(await callTool('account_search', { query: 'blocked' })),
            ).toMatchObject({ kind: 'implementation' });
        } finally {
            jwtHook.authorizeJwt = original;
            jwtHook.parseJwt = parse;
        }
    });

    it('application policy can grant a tool beyond the default role predicate', async () => {
        const original = jwtHook.authorizeJwt.bind(jwtHook);
        jwtHook.authorizeJwt = async () => {};
        try {
            const tools = resultOf((await post(request('tools/list'))).payload)['tools'];
            expect(JSON.stringify(tools)).toContain('admin_search');
            expect(
                structuredOf(await callTool('admin_search', { query: 'app-approved' })),
            ).toMatchObject({ userId: 'user-7' });
        } finally {
            jwtHook.authorizeJwt = original;
        }
    });

    it('rejects forged trusted ingress headers before schemas or minting', async () => {
        const minted = jwtHook.mintedTokens.length;
        for (const headers of [
            { 'x-user-id': 'another-user' },
            { 'x-webpieces-roles': 'admin' },
            { 'x-wp-surface': 'gui' },
        ]) {
            const reply = await post(
                request('tools/call', { name: 'admin_search', arguments: {} }),
                'mcp-user',
                headers,
            );
            expect(reply.response.status).toBe(401);
            expect(JSON.stringify(reply.payload)).not.toContain('$.query');
        }
        expect(jwtHook.mintedTokens).toHaveLength(minted);
    });

    it('concurrent requests keep their bridge credential and principal isolated', async () => {
        const replies = await Promise.all([
            callTool('account_search', { query: 'learner' }, 'mcp-user'),
            callTool('admin_search', { query: 'admin' }, 'mcp-admin'),
        ]);
        expect(structuredOf(replies[0])).toMatchObject({ userId: 'user-7', result: 'learner' });
        expect(structuredOf(replies[1])).toMatchObject({ userId: 'admin-7', result: 'admin' });
    });
});
