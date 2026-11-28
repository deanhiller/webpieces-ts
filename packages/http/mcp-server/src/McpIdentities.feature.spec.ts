import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/client';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    HeaderRegistry,
    Mcp,
    McpToolCatalogFile,
    McpToolDefinition,
    McpToolProfiles,
    WebpiecesCoreHeaders,
    getWpMcpTools,
    WpMcpToolMetadata,
} from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouter, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpToolCatalog } from './McpToolCatalog';
import { McpToolset } from './McpToolset';
import { WpMcpServer } from './WpMcpServer';
import { WpMcpInMemory } from './WpMcpInMemory';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import {
    mcpOAuth,
    McpAccessTokenFormat,
    VerifiedMcpCredential,
    WpMcpServerConfig,
} from './McpAuth';
import { TestJwtHook, TestTokenAuthority } from './__tests__/WpMcpServerTestFixtures';
import { McpHttpTestHarness, TestServers } from './__tests__/McpHttpTestHarness';
import { RenamedApi, RenamedController } from './__tests__/McpIdentityFixtures';
import { VerifiedCaller } from './__tests__/McpTransportFixtures';

const NAMES = [
    'aideveloper_inspect_issues',
    'aideveloper_list_issues',
    'bugfixer_inspect_issues',
    'bugfixer_list_issues',
];
const GOLDEN = path.resolve(
    __dirname,
    '../../../docs/api-doc-model/src/__tests__/goldens/mcp-RenamedApi-tools.json',
);
const CATALOG = new McpToolCatalog(
    McpToolCatalogFile.fromJsonText('mcp-RenamedApi-tools.json', fs.readFileSync(GOLDEN, 'utf8')),
    path.dirname(GOLDEN),
);
const ADMIN = new VerifiedCaller('admin-7', ['admin']);
const USER = new VerifiedCaller('user-7', []);

/** Observe the SDK's PUBLIC schema lookup inside a real request, without replacing dispatch or auth. */
class ObservedToolset extends McpToolset {
    readonly schemaViews: string[][] = [];
    override createSdkServer(
        ...args: Parameters<McpToolset['createSdkServer']>
    ): ReturnType<McpToolset['createSdkServer']> {
        const server = super.createSdkServer(
            args[0],
            args[1],
            async () => {
                const request = await args[2]();
                this.schemaViews.push(
                    NAMES.filter((name: string) => server.toolInputSchemaJson(name) !== undefined),
                );
                return request;
            },
            args[3],
        );
        return server;
    }
}

class FixedResourceAuthority extends TestTokenAuthority {
    override async verifyAccessToken(
        token: string,
        _expected: string,
    ): Promise<VerifiedMcpCredential> {
        const [identity, resource] = token.split('|');
        return super.verifyAccessToken(identity, resource);
    }
}

class IdentitySurface {
    bridge!: WpMcpServer;
    http!: McpHttpTestHarness;
    memory!: Client;
    tools!: ObservedToolset;
    constructor(
        readonly mount: string,
        readonly profiles: McpToolProfiles,
    ) {}
    resource(): string {
        return `https://fixed.example.test${this.mount}`;
    }
    token(admin = true): string {
        return `${admin ? 'mcp-admin' : 'mcp-user'}|${this.resource()}`;
    }
    async names(admin = true): Promise<string[]> {
        const reply = await this.http.post(this.http.request('tools/list'), this.token(admin));
        const tools = this.http.resultOf(reply.payload)['tools'] as Array<{ name: string }>;
        return tools.map((tool: { name: string }) => tool.name);
    }
}

describe('one API method with isolated MCP product identities', () => {
    const surfaces = [
        new IdentitySurface('/legacy', [Mcp.DEFAULT]),
        new IdentitySurface('/new', ['aideveloper']),
        new IdentitySurface('/union', ['aideveloper', Mcp.DEFAULT]),
    ];
    let router: WebpiecesRouter;
    let http: Server;
    beforeAll(async () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, true);
        router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TestJwtHook());
                }),
            ],
        });
        router.addRoutes(RenamedApi, RenamedController);
        const app = express();
        for (const surface of surfaces) {
            surface.tools = new ObservedToolset(
                [McpApiBinding.local(RenamedApi, router)],
                [CATALOG],
                router.authorizationService(),
                surface.profiles,
            );
            const config = new WpMcpServerConfig()
                .setName('rename')
                .setTitle('Rename test')
                .setDescription('Two product identities call one implementation.')
                .setWebsiteUrl('https://docs.example.test')
                .setVersion('1')
                .setResource(surface.resource())
                .setAuth([
                    mcpOAuth(
                        new FixedResourceAuthority(),
                        ['https://login.example.test'],
                        ['tools'],
                        McpAccessTokenFormat.everyBearer(),
                    ),
                ]);
            surface.bridge = new WpMcpServer(config, surface.tools);
            surface.bridge.bind(
                app,
                new McpBindOptions(surface.mount, McpDeployment.singleProcess()),
            );
            surface.memory = await WpMcpInMemory.connect(surface.tools);
        }
        http = await TestServers.listen(app);
        for (const surface of surfaces)
            surface.http = new McpHttpTestHarness(TestServers.urlOf(http), surface.mount);
    });
    afterAll(async () => {
        await Promise.all(
            surfaces.flatMap((surface: IdentitySurface) => [
                surface.memory.close(),
                surface.bridge.close(),
            ]),
        );
        await TestServers.close(http);
    });

    it('serves isolated names and explicit unions, with the same role projection on HTTP and in memory', async () => {
        const expected = [
            ['bugfixer_inspect_issues', 'bugfixer_list_issues'],
            ['aideveloper_inspect_issues', 'aideveloper_list_issues'],
            NAMES,
        ];
        expect(
            await Promise.all(surfaces.map((surface: IdentitySurface) => surface.names())),
        ).toEqual(expected);
        expect(
            await Promise.all(
                surfaces.map((surface: IdentitySurface) =>
                    ADMIN.run(async () =>
                        (await surface.memory.listTools()).tools.map((tool) => tool.name),
                    ),
                ),
            ),
        ).toEqual(expected);
        for (let i = 0; i < surfaces.length; i++) {
            const surface = surfaces[i];
            const allowed = expected[i].filter((name: string) => name.includes('_list_'));
            expect(await surface.names(false)).toEqual(allowed);
            expect(
                await USER.run(async () =>
                    (await surface.memory.listTools()).tools.map((tool) => tool.name),
                ),
            ).toEqual(allowed);
            expect(surface.tools.schemaViews.slice(-2)).toEqual([allowed, allowed]);
        }
    });

    it('both names invoke the same endpoint, preserve cached legacy calls, and record the actual identity', async () => {
        const cached = surfaces[0].http.request('tools/call', {
            name: 'bugfixer_list_issues',
            arguments: { query: 'cached' },
        });
        for (const name of NAMES) {
            const reply = await surfaces[2].http.callTool(
                name,
                { query: 'same' },
                surfaces[2].token(),
            );
            expect(reply.result?.['structuredContent']).toEqual({
                userId: 'admin-7',
                result: 'same',
            });
            const memory = await ADMIN.run(() =>
                surfaces[2].memory.callTool({ name, arguments: { query: 'same' } }),
            );
            expect(memory.structuredContent).toEqual({ userId: 'admin-7', result: 'same' });
        }
        for (let i = 0; i < 2; i++) {
            const reply = await surfaces[0].http.post(cached, surfaces[0].token());
            expect(reply.payload.result?.['structuredContent']).toEqual({
                userId: 'admin-7',
                result: 'cached',
            });
        }
        expect(RenamedController.invokedNames).toEqual([
            ...NAMES.flatMap((name: string) => [name, name]),
            'bugfixer_list_issues',
            'bugfixer_list_issues',
        ]);
    });

    it('refuses excluded and role-denied identities before input schema validation or invocation', async () => {
        const before = RenamedController.invokedNames.length;
        for (const [surface, hidden] of [
            [surfaces[0], 'aideveloper_list_issues'],
            [surfaces[1], 'bugfixer_list_issues'],
        ] as const) {
            const reply = await surface.http.callTool(hidden, { wrong: 'schema' }, surface.token());
            expect(reply.error?.code).toBe(-32602);
            expect(JSON.stringify(reply)).not.toContain('Search text');
            await expect(
                ADMIN.run(() =>
                    surface.memory.callTool({ name: hidden, arguments: { wrong: 'schema' } }),
                ),
            ).rejects.toThrow(`Unknown tool: ${hidden}`);
        }
        for (const surface of surfaces) {
            for (const name of NAMES.filter((name: string) => name.includes('_inspect_'))) {
                expect(
                    (await surface.http.callTool(name, { query: 'denied' }, surface.token(false)))
                        .error?.code,
                ).toBe(-32602);
                await expect(
                    USER.run(() =>
                        surface.memory.callTool({ name, arguments: { query: 'denied' } }),
                    ),
                ).rejects.toThrow(`Unknown tool: ${name}`);
            }
        }
        expect(RenamedController.invokedNames.length).toBe(before);
    });

    it('keeps schemas, endpoint hints and prose identical between product names', async () => {
        const union = await ADMIN.run(() => surfaces[2].memory.listTools());
        for (const method of ['inspect', 'list']) {
            const legacy = union.tools.find((tool) => tool.name === `bugfixer_${method}_issues`)!;
            const renamed = union.tools.find(
                (tool) => tool.name === `aideveloper_${method}_issues`,
            )!;
            expect(renamed).toEqual({ ...legacy, name: renamed.name });
        }
        expect(getWpMcpTools(RenamedApi).map((tool: WpMcpToolMetadata) => tool.name)).toEqual([
            'aideveloper_list_issues',
            'bugfixer_list_issues',
            'aideveloper_inspect_issues',
            'bugfixer_inspect_issues',
        ]);
    });

    it('keeps concurrent caller/surface schemas private and checks exact resource audiences', async () => {
        await Promise.all(
            Array.from({ length: 12 }, async (_value, i: number) => {
                const surface = surfaces[i % 3];
                const caller = i % 2 === 0 ? ADMIN : USER;
                const expected = NAMES.filter(
                    (name: string) =>
                        (surface === surfaces[2] ||
                            name.startsWith(
                                surface === surfaces[0] ? 'bugfixer_' : 'aideveloper_',
                            )) &&
                        (caller === ADMIN || name.includes('_list_')),
                );
                expect(
                    await caller.run(async () =>
                        (await surface.memory.listTools()).tools.map((tool) => tool.name),
                    ),
                ).toEqual(expected);
                expect(await surface.names(caller === ADMIN)).toEqual(expected);
            }),
        );
        const crossed = await surfaces[1].http.post(
            surfaces[1].http.request('tools/list'),
            surfaces[0].token(),
            { host: 'forged.example', 'mcp-profile': 'default' },
        );
        expect(crossed.response.status).toBe(401);
    });

    it('checks complete catalogs before profiles: missing, stale, duplicate and unbound identities fail', () => {
        const original = CATALOG.file.tools;
        const alter = (
            tool: McpToolDefinition,
            method: string,
            profiles: readonly string[],
        ): McpToolDefinition =>
            new McpToolDefinition(
                tool.name,
                tool.title,
                method,
                tool.description,
                tool.hints,
                tool.inputSchema,
                tool.outputSchema,
                profiles,
            );
        const badFiles = [
            original.filter((tool: McpToolDefinition) => tool.name !== 'aideveloper_list_issues'),
            original.map((tool: McpToolDefinition) => alter(tool, 'missing', tool.profiles)),
            original.map((tool: McpToolDefinition) => alter(tool, tool.methodName, ['other'])),
        ];
        for (const tools of badFiles) {
            expect(
                () =>
                    new McpToolset(
                        [McpApiBinding.local(RenamedApi, router)],
                        [new McpToolCatalog(new McpToolCatalogFile('RenamedApi', tools), '(bad)')],
                        router.authorizationService(),
                        [Mcp.DEFAULT],
                    ),
            ).toThrow(/catalog|rebuild/i);
        }
        expect(
            () =>
                new McpToolset(
                    [McpApiBinding.local(RenamedApi, router)],
                    [],
                    router.authorizationService(),
                    [Mcp.DEFAULT],
                ),
        ).toThrow(/no mcp-RenamedApi-tools.json/);
        expect(
            () =>
                new McpToolset(
                    [McpApiBinding.local(RenamedApi, router)],
                    [
                        CATALOG,
                        new McpToolCatalog(
                            new McpToolCatalogFile('UnboundApi', CATALOG.file.tools),
                            '(unbound)',
                        ),
                    ],
                    router.authorizationService(),
                    [Mcp.DEFAULT],
                ),
        ).toThrow(/does not bind/);
        expect(
            () =>
                new McpToolset(
                    [
                        McpApiBinding.local(RenamedApi, router),
                        McpApiBinding.local(RenamedApi, router),
                    ],
                    [CATALOG],
                    router.authorizationService(),
                    [Mcp.DEFAULT],
                ),
        ).toThrow(/Duplicate @WpMcpTool name/);
        expect(() =>
            McpToolCatalogFile.fromJsonText(
                'mcp-RenamedApi-tools.json',
                JSON.stringify([...original, original[0]]),
            ),
        ).toThrow(/duplicate/i);
    });
});
