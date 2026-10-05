import { AuthorizationService } from '@webpieces/http-routing';
import 'reflect-metadata';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiForbiddenError, AuthorizationRequirement, HeaderRegistry, WebpiecesCoreHeaders } from '@webpieces/core-util';
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

class ObservedAuthorizationService extends AuthorizationService {
    observer?: () => Promise<void>;
    // webpieces-disable no-any-unknown -- observes the framework's erased policy boundary in this integration fixture
    override async authorize(requirement: AuthorizationRequirement<unknown>): Promise<void> {
        await this.observer?.();
        await super.authorize(requirement);
    }
}

describe('MCP principal authorization and one transport context', () => {
    let bridge: WpMcpServer<string>;
    let httpServer: Server;
    let controller: SearchController;
    let jwtHook: TestJwtHook;
    let authority: TestTokenAuthority;
    let harness: McpHttpTestHarness;
    let baseUrl: string;
    let policy: ObservedAuthorizationService;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        jwtHook = new TestJwtHook();
        authority = new TestTokenAuthority();
        policy = new ObservedAuthorizationService();
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);

        });
        const overrides = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.rebindSync(AuthorizationService).toConstantValue(policy);
        });
        const router = await WebpiecesRouterFactory.create({ appBindings: [bindings], appOverrides: overrides });
        router.addRoutes(SearchApi, SearchController);
        controller = router.getContainer().get(SearchController);
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string>()
                .setName('authorization-spec')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/app-owned/mcp')
                .setAccessTokenAuthority(authority)
                .setAuthorizationService(policy)
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

    it('publishes canonical identity before policy and retains ingress context through local execution', async () => {
        let evaluations = 0;
        let ingressRequest: object | undefined;
        policy.observer = async () => {
            await Promise.resolve();
            expect(RequestContext.getTrusted(AUTHENTICATED_CALLER_KEY)?.userId).toBe('user-7');
            expect(RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID)).toBe('user-7');
            expect(RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ROLES)).toBe('[]');
            expect(RequestContext.getTrusted(WebpiecesCoreHeaders.SURFACE)).toBe('llm');
            expect(RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID)).toBe('scope-1134');
            expect(RequestContext.getRequest()?.path).toBe(ENDPOINT_PATH);
            if (!ingressRequest) ingressRequest = RequestContext.getRequest();
            expect(RequestContext.getRequest()).toBe(ingressRequest);
            evaluations += 1;
        };
        try {
            const reply = await post(request('tools/call', {name:'account_search',arguments:{query:'same'}}), 'mcp-user', {'x-request-id':'scope-1134'});
            expect(structuredOf(reply.payload)).toMatchObject({userId:'user-7',result:'same'});
            // Three projection checks, one dispatch check, one receiving endpoint check.
            expect(evaluations).toBe(5);
            expect(jwtHook.mintedTokens).toEqual([]);
            expect(RequestContext.isActive()).toBe(false);
        } finally { policy.observer = undefined; }
    });

    it('rechecks dispatch before argument validation and hides a permission change', async () => {
        let checks = 0;
        policy.observer = async () => {
            checks += 1;
            if (checks > 3) throw new ApiForbiddenError('SECRET-policy-denial');
        };
        try {
            const reply = await callTool('account_search', {});
            expect(reply.error).toMatchObject({code:-32602,message:'Unknown tool: account_search'});
            expect(JSON.stringify(reply)).not.toContain('SECRET');
            expect(JSON.stringify(reply)).not.toContain('$.query');
            expect(jwtHook.mintedTokens).toEqual([]);
        } finally { policy.observer = undefined; }
    });

    it('rechecks receiving endpoint policy after visible dispatch', async () => {
        let checks = 0;
        policy.observer = async () => {
            checks += 1;
            if (checks === 5) throw new ApiForbiddenError('resource-specific denial');
        };
        try {
            expect(modelErrorOf(await callTool('account_search', {query:'blocked'}))).toMatchObject({kind:'forbidden'});
            expect(checks).toBe(5);
        } finally { policy.observer = undefined; }
    });

    it('credential authority cannot widen a standard role policy through a JWT hook', async () => {
        jwtHook.parseJwt = async () => { throw new Error('MCP must never parse endpoint JWTs'); };
        const tools = resultOf((await post(request('tools/list'))).payload)['tools'];
        expect(JSON.stringify(tools)).not.toContain('admin_search');
        expect(structuredOf(await callTool('account_search', {query:'permitted'}))).toMatchObject({userId:'user-7'});
        expect(jwtHook.mintedTokens).toEqual([]);
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
