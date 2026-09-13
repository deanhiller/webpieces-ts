import 'reflect-metadata';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import {
    ApiPath,
    ApiBadRequestError,
    ApiEndUserError,
    ContextKey,
    ContextTuple,
    Endpoint,
    HeaderRegistry,
    WpAuthJwt,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpMcpTool,
    WpResponseDto,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import {
    AuthenticatedCaller,
    JWT_HOOK,
    JwtHook,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import {
    McpAccessTokenVerifier,
    VerifiedMcpCredential,
    WpMcpServerConfig,
} from './McpAuth';
import { WpMcpServer } from './WpMcpServer';

const USER_ID = ContextKey.trusted<string>('mcpSpecUserId', 'identity proven by TestJwtHook');

@WpDto()
class SearchRequest {
    @WpDtoField(new WpDtoFieldOptions('Search text', true))
    query!: string;
}

@WpDto()
class SearchResponse {
    @WpDtoField(new WpDtoFieldOptions('Authenticated user that executed the endpoint', true))
    userId!: string;

    @WpDtoField(new WpDtoFieldOptions('Search result', true))
    result!: string;
}

@ApiPath('/mcp-spec')
abstract class SearchApi {
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'account_search',
        description: 'Search records owned by the authenticated user.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    search(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    @WpAuthJwt({ roles: ['admin'] })
    @Endpoint('/admin', 'rpc')
    @WpResponseDto(() => SearchResponse)
    @WpMcpTool({
        name: 'admin_search',
        description: 'Search all accounts. Administrators only.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    admin(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/not-a-tool', 'rpc')
    notATool(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

@injectable()
class SearchController extends SearchApi {
    adminInvocations = 0;

    override async search(request: SearchRequest): Promise<SearchResponse> {
        if (request.query === 'internal') throw new Error('database password appeared here');
        if (request.query === 'bad') {
            throw new ApiBadRequestError('SQL table secret', 'query', 'Choose a different query');
        }
        if (request.query === 'human') {
            throw new ApiEndUserError('Those two values do not match', 'MISMATCH');
        }
        const response = new SearchResponse();
        response.userId = RequestContext.getTrusted(USER_ID) ?? 'missing';
        response.result = request.query;
        return response;
    }

    override async admin(request: SearchRequest): Promise<SearchResponse> {
        this.adminInvocations += 1;
        return this.search(request);
    }

    override async notATool(request: SearchRequest): Promise<SearchResponse> {
        return this.search(request);
    }
}

class TestJwtHook extends JwtHook {
    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        if (token === 'admin-endpoint-token') {
            return new AuthenticatedCaller('admin-7', ['admin'], [new ContextTuple(USER_ID, 'admin-7')]);
        }
        if (token !== 'user-endpoint-token') throw new Error('invalid test token');
        return new AuthenticatedCaller('user-7', [], [new ContextTuple(USER_ID, 'user-7')]);
    }
}

class TestMcpTokenVerifier extends McpAccessTokenVerifier {
    seenResource?: string;

    override async verify(token: string, expectedResource: string): Promise<VerifiedMcpCredential> {
        this.seenResource = expectedResource;
        if (token === 'mcp-admin') {
            return this.credential('admin-endpoint-token', expectedResource, ['admin']);
        }
        if (token === 'mcp-wrong-resource') {
            return this.credential('user-endpoint-token', 'https://attacker.test/mcp', []);
        }
        if (token === 'mcp-wrong-issuer') {
            return new VerifiedMcpCredential(
                'user-endpoint-token',
                'https://attacker.test',
                expectedResource,
                Math.floor(Date.now() / 1000) + 60,
                ['tools'],
            );
        }
        if (token === 'mcp-expired') {
            return new VerifiedMcpCredential(
                'user-endpoint-token',
                'https://login.example.test',
                expectedResource,
                Math.floor(Date.now() / 1000) - 1,
                ['tools'],
            );
        }
        if (token === 'mcp-missing-scope') {
            return new VerifiedMcpCredential(
                'user-endpoint-token',
                'https://login.example.test',
                expectedResource,
                Math.floor(Date.now() / 1000) + 60,
                [],
            );
        }
        if (token !== 'mcp-user') throw new Error('wrong issuer, expiry, audience, or signature');
        return this.credential('user-endpoint-token', expectedResource, []);
    }

    private credential(
        endpointToken: string,
        resource: string,
        roles: readonly string[],
    ): VerifiedMcpCredential {
        return new VerifiedMcpCredential(
            endpointToken,
            'https://login.example.test',
            resource,
            Math.floor(Date.now() / 1000) + 60,
            ['tools'],
            roles,
        );
    }
}

describe('WpMcpServer secure API bridge', () => {
    let bridge: WpMcpServer;
    let controller: SearchController;
    let verifier: TestMcpTokenVerifier;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        const jwtHook = new TestJwtHook();
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        const router: WebpiecesRouter = await WebpiecesRouterFactory.create({ appBindings: [bindings] });
        router.addRoutes(SearchApi, SearchController);
        controller = router.getContainer().get(SearchController);
        verifier = new TestMcpTokenVerifier();
        bridge = new WpMcpServer(
            new WpMcpServerConfig(
                'test-server',
                '1.0.0',
                'https://api.example.test/mcp',
                verifier,
                ['https://login.example.test'],
                ['tools'],
            ),
            router,
            [SearchApi],
        );
    });

    async function connect(token: string): Promise<Client> {
        const server = await bridge.build(token);
        const pair = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'spec-client', version: '1.0.0' });
        await Promise.all([server.connect(pair[1]), client.connect(pair[0])]);
        return client;
    }

    it('publishes annotation documentation and generated request/response schemas', async () => {
        const client = await connect('mcp-user');
        const listed = await client.listTools();
        await client.close();

        expect(verifier.seenResource).toBe('https://api.example.test/mcp');
        expect(listed.tools.map((tool: (typeof listed.tools)[number]) => tool.name)).toEqual(['account_search']);
        expect(listed.tools[0]).toMatchObject({
            description: 'Search records owned by the authenticated user.',
            inputSchema: {
                required: ['query'],
                properties: { query: { type: 'string', description: 'Search text' } },
            },
            outputSchema: {
                required: ['userId', 'result'],
                properties: { userId: { description: 'Authenticated user that executed the endpoint' } },
            },
        });
    });

    it('refuses an access token unless the app verifier accepts it for this exact resource', async () => {
        await expect(bridge.build('wrong-resource-token')).rejects.toThrow(/issuer.*audience/i);
        await expect(bridge.build('mcp-wrong-resource')).rejects.toThrow(/protected resource/i);
        await expect(bridge.build('mcp-wrong-issuer')).rejects.toThrow(/issuer is not trusted/i);
        await expect(bridge.build('mcp-expired')).rejects.toThrow(/expired/i);
        await expect(bridge.build('mcp-missing-scope')).rejects.toThrow(/scope 'tools'/i);
        expect(verifier.seenResource).toBe('https://api.example.test/mcp');
    });

    it('uses a protocol error for an unknown tool instead of a tool execution result', async () => {
        const client = await connect('mcp-user');

        await expect(client.callTool({ name: 'not_a_tool', arguments: {} })).rejects.toThrow(
            /Unknown tool/,
        );
        await client.close();
    });

    it('re-enters AuthFilter and seeds trusted identity only from the endpoint JWT hook', async () => {
        const client = await connect('mcp-user');
        const result = await client.callTool({ name: 'account_search', arguments: { query: 'mine' } });
        await client.close();

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ userId: 'user-7', result: 'mine' });
    });

    it('rejects caller-supplied fields before they can become context', async () => {
        const client = await connect('mcp-user');
        const result = await client.callTool({
            name: 'account_search',
            arguments: { query: 'mine', userId: 'admin-7', roles: ['admin'] },
        });
        await client.close();

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ kind: 'bad-request' });
        expect(JSON.stringify(result)).not.toContain('admin-7');
    });

    it('treats tools/list filtering as UX and still denies a direct hidden-tool call', async () => {
        const client = await connect('mcp-user');
        const result = await client.callTool({ name: 'admin_search', arguments: { query: 'all' } });
        await client.close();

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ kind: 'forbidden' });
        expect(controller.adminInvocations).toBe(0);
    });

    it('never exposes raw bad-request or implementation diagnostics to the model', async () => {
        const client = await connect('mcp-user');
        const bad = await client.callTool({ name: 'account_search', arguments: { query: 'bad' } });
        const internal = await client.callTool({ name: 'account_search', arguments: { query: 'internal' } });
        await client.close();

        expect(JSON.stringify(bad)).not.toContain('SQL table secret');
        expect(JSON.stringify(internal)).not.toContain('database password');
        expect(internal.structuredContent).toMatchObject({
            kind: 'implementation',
            message: 'Internal Error',
        });
        expect(internal.structuredContent?.['requestId']).toMatch(/^svrGenReqId-/);
    });

    it('shows explicitly end-user-safe errors to the model', async () => {
        const client = await connect('mcp-user');
        const result = await client.callTool({ name: 'account_search', arguments: { query: 'human' } });
        await client.close();

        expect(result.structuredContent).toMatchObject({
            kind: 'end-user',
            message: 'Those two values do not match',
            errorCode: 'MISMATCH',
        });
    });

    it('returns protected-resource metadata without implementing an authorization server', () => {
        expect(bridge.protectedResourceMetadata()).toMatchObject({
            resource: 'https://api.example.test/mcp',
            authorization_servers: ['https://login.example.test'],
            bearer_methods_supported: ['header'],
            scopes_supported: ['tools'],
        });
    });
});
