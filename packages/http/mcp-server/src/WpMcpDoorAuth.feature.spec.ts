import 'reflect-metadata';
import { Server } from 'node:http';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    apiKey,
    HeaderRegistry,
    jwt,
    oidcSameProject,
    vendorAuth,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import {
    API_KEY_HOOK,
    JWT_HOOK,
    OIDC_HOOK,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpHttpAuth, WpMcpServerConfig, McpAccessTokenFormat, mcpOAuth } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpToolset } from './McpToolset';
import { WpMcpServer } from './WpMcpServer';
import { McpHttpTestHarness, McpPostReply, TestServers } from './__tests__/McpHttpTestHarness';
import {
    DevOidcTokens,
    OAUTH_ISSUER,
    OTHER_PROJECT_SA,
    PARTNER_KEY,
    PrefixTokenAuthority,
    ProjectOidcHook,
    SAME_PROJECT_SA,
    STORE_CATALOG,
    StoreApi,
    StoreController,
    TransportApiKeyHook,
    TransportJwtHook,
} from './__tests__/McpTransportFixtures';

const SAME_PROJECT = DevOidcTokens.of(SAME_PROJECT_SA);
const ALICE_CONTEXT = { 'x-user-id': 'alice', 'x-webpieces-roles': '["OPERATOR"]' };
const BOB_CONTEXT = { 'x-user-id': 'bob', 'x-webpieces-roles': '[]' };

function names(harness: McpHttpTestHarness, reply: McpPostReply): string[] {
    const tools = harness.resultOf(reply.payload)['tools'] as Array<Record<string, string>>;
    return tools.map((tool: Record<string, string>) => tool['name']);
}

/**
 * The HTTP door (#1416): an OR-set of the existing @WpAuth modes plus mcpOAuth(...), classified from
 * unverified surface facts and verified by exactly ONE verifier.
 */
describe('WpMcpServer HTTP door: setAuth([...]) classify-then-verify', () => {
    let router: WebpiecesRouter;
    let jwtHook: TransportJwtHook;
    let oidcHook: ProjectOidcHook;
    let http: Server;
    const servers: WpMcpServer[] = [];
    let internal: McpHttpTestHarness;
    let mixed: McpHttpTestHarness;
    let userPath: McpHttpTestHarness;
    let adminPath: McpHttpTestHarness;

    function toolset(profile: string): McpToolset {
        return new McpToolset(
            [McpApiBinding.local(StoreApi, router)],
            [STORE_CATALOG],
            router.authorizationService(),
            [profile],
        );
    }

    function config(
        path: string,
        auth: readonly [McpHttpAuth, ...McpHttpAuth[]],
    ): WpMcpServerConfig {
        return new WpMcpServerConfig()
            .setName('door-spec')
            .setTitle('Door spec')
            .setDescription('Exercises the MCP HTTP door auth modes.')
            .setWebsiteUrl('https://docs.example.test/mcp')
            .setVersion('1.0.0')
            .setResource(`https://api.example.test${path}`)
            .setAuth(auth)
            .setCredentialVerifiers(router.credentialVerifiers());
    }

    function mount(
        app: Express,
        path: string,
        auth: readonly [McpHttpAuth, ...McpHttpAuth[]],
        profile = 'user',
    ): void {
        const server = new WpMcpServer(config(path, auth), toolset(profile));
        server.bind(app, new McpBindOptions(path, McpDeployment.singleProcess()));
        servers.push(server);
    }

    beforeAll(async () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, true);
        jwtHook = new TransportJwtHook();
        oidcHook = new ProjectOidcHook();
        router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(jwtHook);
                    options.bind(OIDC_HOOK).toConstantValue(oidcHook);
                    options.bind(API_KEY_HOOK).toConstantValue(new TransportApiKeyHook());
                }),
            ],
        });
        router.addRoutes(StoreApi, StoreController);
        const app = express();
        mount(app, '/mcp/internal', [oidcSameProject()]);
        mount(app, '/mcp/mixed', [
            oidcSameProject(),
            jwt(),
            apiKey('partner', [{ in: 'header', key: PARTNER_KEY }]),
            mcpOAuth(
                new PrefixTokenAuthority(),
                [OAUTH_ISSUER],
                ['tools'],
                McpAccessTokenFormat.opaquePrefix('wpmcp_'),
            ),
        ]);
        mount(app, '/mcp/user', [jwt()], 'user');
        mount(app, '/mcp/admin', [jwt()], 'admin');
        http = await TestServers.listen(app);
        const base = TestServers.urlOf(http);
        internal = new McpHttpTestHarness(base, '/mcp/internal');
        mixed = new McpHttpTestHarness(base, '/mcp/mixed');
        userPath = new McpHttpTestHarness(base, '/mcp/user');
        adminPath = new McpHttpTestHarness(base, '/mcp/admin');
    });

    afterAll(async () => {
        await Promise.all(servers.map((server: WpMcpServer) => server.close()));
        await TestServers.close(http);
    });

    describe('[oidcSameProject()] — internal svc-to-svc MCP', () => {
        it('projects tools by the user a verified same-project caller propagated', async () => {
            const alice = await internal.post(
                internal.request('tools/list'),
                SAME_PROJECT,
                ALICE_CONTEXT,
            );
            expect(names(internal, alice)).toEqual(['stores_list', 'stores_pause']);
            const bob = await internal.post(
                internal.request('tools/list'),
                SAME_PROJECT,
                BOB_CONTEXT,
            );
            expect(names(internal, bob)).toEqual(['stores_list']);

            const call = await internal.post(
                internal.request('tools/call', {
                    name: 'stores_pause',
                    arguments: { query: 'now' },
                }),
                SAME_PROJECT,
                ALICE_CONTEXT,
            );
            expect(internal.structuredOf(call.payload)).toEqual({ userId: 'alice', result: 'now' });
        });

        it('refuses another project with a plain 401 and no OAuth discovery', async () => {
            const before = StoreController.calls.length;
            const reply = await internal.post(
                internal.request('tools/call', { name: 'stores_list', arguments: { query: 'x' } }),
                DevOidcTokens.of(OTHER_PROJECT_SA),
                ALICE_CONTEXT,
            );
            expect(reply.response.status).toBe(401);
            expect(reply.response.headers.get('www-authenticate')).toBeNull();
            expect(StoreController.calls.length).toBe(before);
        });

        it('refuses an unverified caller that sends trusted headers, never emitting discovery', async () => {
            const anonymous = await internal.post(
                internal.request('tools/list'),
                null,
                ALICE_CONTEXT,
            );
            expect(anonymous.response.status).toBe(401);
            expect(anonymous.response.headers.get('www-authenticate')).toBeNull();
            const userToken = await internal.post(
                internal.request('tools/list'),
                'jwt-alice',
                ALICE_CONTEXT,
            );
            expect(userToken.response.status).toBe(401);
            expect(userToken.response.headers.get('www-authenticate')).toBeNull();
        });
    });

    describe('[oidcSameProject(), jwt(), apiKey(...), mcpOAuth(...)] — every population on one path', () => {
        async function caller(
            token: string | null,
            headers: Record<string, string> = {},
        ): Promise<unknown> {
            const reply = await mixed.post(
                mixed.request('tools/call', { name: 'stores_pause', arguments: { query: 'go' } }),
                token,
                headers,
            );
            return mixed.structuredOf(reply.payload)['userId'];
        }

        it('admits each population through its own verifier', async () => {
            expect(await caller(SAME_PROJECT, ALICE_CONTEXT)).toBe('alice');
            expect(await caller('jwt-alice')).toBe('alice');
            expect(await caller(null, { 'x-partner-key': 'key-carol' })).toBe('carol');
            expect(await caller('wpmcp_dave')).toBe('dave');
        });

        it('a forged Google-looking token is a 401 from the OIDC verifier, never retried as jwt()', async () => {
            const forged = DevOidcTokens.forgedGoogleJwt();
            const reply = await mixed.post(mixed.request('tools/list'), forged);
            expect(reply.response.status).toBe(401);
            expect(reply.response.headers.get('www-authenticate')).toBeNull();
            expect(oidcHook.tokens).toContain(forged);
            expect(jwtHook.parsed).not.toContain(forged);
        });

        it('an api-key header AND a bearer together are ambiguous and refused', async () => {
            const before = jwtHook.parsed.length;
            const reply = await mixed.post(mixed.request('tools/list'), 'jwt-alice', {
                'x-partner-key': 'key-carol',
            });
            expect(reply.response.status).toBe(401);
            expect(jwtHook.parsed.length).toBe(before);
        });

        it('no credential is answered with the mcpOAuth discovery challenge; a rejected jwt is a plain 401', async () => {
            const none = await mixed.post(mixed.request('tools/list'), null);
            expect(none.response.status).toBe(401);
            expect(none.response.headers.get('www-authenticate')).toBe(
                'Bearer resource_metadata="https://api.example.test/.well-known/oauth-protected-resource/mcp/mixed"',
            );
            const badJwt = await mixed.post(mixed.request('tools/list'), 'jwt-mallory');
            expect(badJwt.response.status).toBe(401);
            expect(badJwt.response.headers.get('www-authenticate')).toBeNull();
            const badOAuth = await mixed.post(mixed.request('tools/list'), 'wpmcp_bad');
            expect(badOAuth.response.status).toBe(401);
            expect(badOAuth.response.headers.get('www-authenticate')).toContain(
                'resource_metadata',
            );
        });

        it('a user-token caller may not assert another user through trusted headers', async () => {
            const reply = await mixed.post(mixed.request('tools/list'), 'jwt-bob', ALICE_CONTEXT);
            expect(reply.response.status).toBe(401);
        });
    });

    describe('one path per profile set', () => {
        it('keeps admin-profile tools off /mcp/user even for an admin-capable caller', async () => {
            expect(
                names(userPath, await userPath.post(userPath.request('tools/list'), 'jwt-alice')),
            ).toEqual(['stores_list', 'stores_pause']);
            expect(
                names(
                    adminPath,
                    await adminPath.post(adminPath.request('tools/list'), 'jwt-alice'),
                ),
            ).toEqual(['stores_purge']);
            const hidden = await userPath.post(
                userPath.request('tools/call', { name: 'stores_purge', arguments: { query: 'x' } }),
                'jwt-alice',
            );
            expect(hidden.payload.error?.code).toBe(-32602);
        });
    });

    describe('startup refuses a set whose modes are not disjoint or not verifiable', () => {
        function bindWith(
            auth: readonly [McpHttpAuth, ...McpHttpAuth[]],
            verifiers = router.credentialVerifiers(),
        ): void {
            new WpMcpServer(
                config('/mcp/refused', auth).setCredentialVerifiers(verifiers),
                toolset('user'),
            ).bind(express(), new McpBindOptions('/mcp/refused', McpDeployment.singleProcess()));
        }

        it('refuses two modes that could claim one request', () => {
            expect(() =>
                bindWith([
                    jwt(),
                    mcpOAuth(
                        new PrefixTokenAuthority(),
                        [OAUTH_ISSUER],
                        ['tools'],
                        McpAccessTokenFormat.everyBearer(),
                    ),
                ]),
            ).toThrow(/mcpOAuth\(\.\.\.\) claims EVERY bearer credential, so it overlaps jwt\(\)/);
            expect(() =>
                bindWith([
                    oidcSameProject(),
                    mcpOAuth(
                        new PrefixTokenAuthority(),
                        ['https://accounts.google.com'],
                        ['tools'],
                        McpAccessTokenFormat.jwtIssuer(),
                    ),
                ]),
            ).toThrow(/trusts the Google issuer https:\/\/accounts\.google\.com/);
            expect(() =>
                bindWith([oidcSameProject(), apiKey('partner', [{ in: 'bearer' }])]),
            ).toThrow(/apiKey\('partner', \.\.\.\) claims EVERY bearer credential/);
        });

        it('refuses vendorAuth and a mode whose verifier is not bound', async () => {
            expect(() => bindWith([vendorAuth('sentry')])).toThrow(/refuses vendorAuth\(\.\.\.\)/);
            const bare = await WebpiecesRouterFactory.create({ appBindings: [] });
            expect(() => bindWith([jwt()], bare.credentialVerifiers())).toThrow(
                /binder\.bind\(JWT_HOOK\)\.to\(YourJwtHook\)/,
            );
        });
    });
});
