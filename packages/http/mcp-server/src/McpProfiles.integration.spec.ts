import 'reflect-metadata';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeaderRegistry, Mcp, McpToolProfiles, McpToolCatalogFile, McpToolDefinition } from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory, WebpiecesRouter } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { WpMcpServerConfig, VerifiedMcpCredential } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import { McpToolCatalog } from './McpToolCatalog';
import { RpcResponse, TestServers, McpHttpTestHarness } from './__tests__/McpHttpTestHarness';
import { TestJwtHook, TestTokenAuthority, USER_ID } from './__tests__/WpMcpServerTestFixtures';
import { ProfileApi, ProfileController, PROFILE_CATALOG } from './__tests__/McpProfileFixtures';

/** Test tokens encode a FIXED audience, rather than echoing the verifier's expected resource. */
class ResourceAuthority extends TestTokenAuthority {
    override async verifyAccessToken(
        token: string,
        _expected: string,
    ): Promise<VerifiedMcpCredential> {
        const [identity, surface] = token.split(':');
        return super.verifyAccessToken(identity, `https://api.example.test${surface}`);
    }
}

class ProfileMount {
    constructor(
        readonly path: string,
        readonly profiles: McpToolProfiles,
    ) {}
    bridge!: WpMcpServer<string>;
    client!: McpHttpTestHarness;
    token(admin: boolean): string {
        return `${admin ? 'mcp-admin' : 'mcp-user'}:${this.path}`;
    }
    async names(admin: boolean): Promise<string[]> {
        const reply = await this.client.post(this.client.request('tools/list'), this.token(admin));
        const tools = this.client.resultOf(reply.payload)['tools'] as Array<Record<string, string>>;
        expect(tools.every((tool: Record<string, string>) => !('profiles' in tool))).toBe(true);
        return tools.map((tool: Record<string, string>) => tool['name']);
    }
}

describe('bound MCP profile and resource isolation', () => {
    const mounts = [
        new ProfileMount('/mcp', [Mcp.DEFAULT]),
        new ProfileMount('/mcp/admin', ['admin']),
        new ProfileMount('/mcp/both', [Mcp.DEFAULT, 'admin']),
        new ProfileMount('/mcp/course', ['course-authoring']),
    ];
    let http: Server;
    let router: WebpiecesRouter;
    let controller: ProfileController;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TestJwtHook());
                }),
            ],
        });
        router.addRoutes(ProfileApi, ProfileController);
        controller = router.getContainer().get(ProfileController);
        const app = express();
        for (const mount of mounts) {
            const profiles: [string, ...string[]] = [mount.profiles[0], ...mount.profiles.slice(1)];
            const config = new WpMcpServerConfig<string>()
                .setName('profiles')
                .setVersion('1')
                .setResource(`https://api.example.test${mount.path}`)
                .setAccessTokenAuthority(new ResourceAuthority())
                .setAuthorizationService(router.authorizationService())
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']);
            if (mount.path !== '/mcp') config.setToolProfiles(profiles);
            mount.bridge = new WpMcpServer(config);
            mount.bridge.bind(
                app,
                new McpBindOptions(
                    mount.path,
                    [McpApiBinding.local(ProfileApi, router)],
                    [PROFILE_CATALOG],
                    McpDeployment.singleProcess(),
                ),
            );
            profiles.push('unselected');
            config.setToolProfiles(['course-authoring']);
        }
        http = await TestServers.listen(app);
        for (const mount of mounts)
            mount.client = new McpHttpTestHarness(TestServers.urlOf(http), mount.path);
    });

    afterAll(async () => {
        await Promise.all(mounts.map((mount: ProfileMount) => mount.bridge.close()));
        await TestServers.close(http);
    });

    it('gives default, admin, union and third-group views independently of account roles', async () => {
        expect(await Promise.all(mounts.map((mount: ProfileMount) => mount.names(true)))).toEqual([
            ['learner', 'shared'],
            ['admin', 'shared'],
            ['admin', 'learner', 'shared'],
            ['course'],
        ]);
        expect(await Promise.all(mounts.map((mount: ProfileMount) => mount.names(false)))).toEqual([
            ['learner'],
            [],
            ['learner'],
            ['course'],
        ]);
    });

    it('denies direct calls to excluded ALL_USERS tools and role-protected shared tools without invoking controllers', async () => {
        const before = controller.calls.length;
        const admin = mounts[1];
        const hidden = await admin.client.callTool(
            'learner',
            { query: 'secret' },
            admin.token(true),
        );
        expect(hidden.error?.code).toBe(-32602);
        expect(JSON.stringify(hidden)).not.toContain('Search text');
        for (const mount of mounts.slice(0, 3)) {
            const shared = await mount.client.callTool(
                'shared',
                { query: 'secret' },
                mount.token(false),
            );
            expect(shared.error?.code).toBe(-32602);
        }
        expect(controller.calls.length).toBe(before);
    });

    it('executes selected tools and keeps concurrent/interleaved caller projections private', async () => {
        const replies = await Promise.all(
            mounts.slice(0, 3).map(async (mount: ProfileMount) => {
                const tool = mount.path === '/mcp' ? 'learner' : 'shared';
                return mount.client.callTool(tool, { query: mount.path }, mount.token(true));
            }),
        );
        expect(
            replies.every(
                (reply: RpcResponse) =>
                    reply.error === undefined && reply.result?.['isError'] !== true,
            ),
        ).toBe(true);
        const views = await Promise.all(
            Array.from({ length: 12 }, async (_value: undefined, index: number) => {
                const mount = mounts[index % 3];
                return mount.names(index % 2 === 0);
            }),
        );
        expect(views[0]).toEqual(['learner', 'shared']);
        expect(views[1]).toEqual([]);
        expect(views[2]).toEqual(['admin', 'learner', 'shared']);
        expect(views[3]).toEqual(['learner']);
    });

    it('rejects cross-resource tokens even with caller-controlled profile hints and Host', async () => {
        for (const [source, target] of [
            [mounts[0], mounts[1]],
            [mounts[1], mounts[0]],
        ]) {
            const reply = await target.client.post(
                target.client.request('tools/list', { profiles: ['admin'] }),
                source.token(true),
                { host: 'attacker.example', 'mcp-profile': 'admin' },
            );
            expect(reply.response.status).toBe(401);
            expect(reply.response.headers.get('www-authenticate')).toContain(
                `oauth-protected-resource${target.path}`,
            );
        }
        for (const mount of mounts) {
            expect(mount.bridge.protectedResourceMetadata().resource).toBe(
                `https://api.example.test${mount.path}`,
            );
        }
    });

    it('validates excluded catalog entries before projection', () => {
        const missing = new McpToolCatalog(
            new McpToolCatalogFile(
                'ProfileApi',
                PROFILE_CATALOG.file.tools.filter(
                    (tool: McpToolDefinition) => tool.name !== 'admin',
                ),
            ),
            '(missing)',
        );
        const stale = new McpToolCatalog(
            new McpToolCatalogFile(
                'ProfileApi',
                PROFILE_CATALOG.file.tools.map(
                    (tool: McpToolDefinition) =>
                        new McpToolDefinition(
                            tool.name,
                            tool.title,
                            tool.methodName,
                            tool.description,
                            tool.hints,
                            tool.inputSchema,
                            tool.outputSchema,
                            [Mcp.DEFAULT],
                        ),
                ),
            ),
            '(stale)',
        );
        for (const catalog of [missing, stale]) {
            const config = new WpMcpServerConfig<string>()
                .setName('invalid')
                .setVersion('1')
                .setResource('https://api.example.test/mcp')
                .setAccessTokenAuthority(new ResourceAuthority())
                .setAuthorizationService(router.authorizationService())
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']);
            expect(() =>
                new WpMcpServer(config).bind(
                    express(),
                    new McpBindOptions(
                        '/mcp',
                        [McpApiBinding.local(ProfileApi, router)],
                        [catalog],
                        McpDeployment.singleProcess(),
                    ),
                ),
            ).toThrow(/catalog|rebuild/i);
        }
    });
});
