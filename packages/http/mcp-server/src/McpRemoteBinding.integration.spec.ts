import 'reflect-metadata';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiPath,
    ClientRegistry,
    ContextKey,
    ContextTuple,
    Endpoint,
    Filter,
    HeaderRegistry,
    Service,
    WebpiecesCoreHeaders,
    WpAuthOidc,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpMcpAuthJwt,
    WpMcpTool,
    WpResponseDto,
} from '@webpieces/core-util';
import {
    HttpRequest,
    Provider,
    RequestContext,
    RequestContextHeaders,
} from '@webpieces/core-context';
import type { GcpOidc } from '@webpieces/gcp-identity';
import {
    ClientFilterDefinition,
    ClientHttpFactory,
    ClientRequest,
    ClientConfig,
    DnsAddressResolver,
    NodeProxyClient,
} from '@webpieces/http-client-node'; // eslint-disable-line @webpieces/enforce-architecture -- test-only end-to-end proof that the topology-neutral MCP binding accepts a real generated Node client
import {
    FilterDefinition,
    MethodMeta,
    OIDC_HOOK,
    OidcHook,
    WebpiecesRouter,
    WebpiecesRouterFactory,
    WpResponse,
} from '@webpieces/http-routing';
// eslint-disable-next-line @webpieces/enforce-architecture -- test-only downstream server fixture; mcp-server production remains transport-level independent
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { McpApiBinding } from './McpApiBinding';
import { McpApiDispatcher, McpDispatchSuccess } from './McpApiDispatcher';
import { VerifiedMcpCredential } from './McpAuth';
import { McpInvocationContext } from './McpInvocationContext';
import { McpToolRegistry, RegisteredMcpTool } from './McpToolRegistry';

const REMOTE_USER = ContextKey.trusted<string>(
    'mcpRemoteUser',
    'verified by the MCP access-token authority before delegation',
    'x-mcp-remote-user',
);
const REMOTE_ROLES = ContextKey.trusted<string>(
    'mcpRemoteRoles',
    'verified by the MCP access-token authority before delegation',
    'x-mcp-remote-roles',
);
const REMOTE_SERVICE = 'mcp-remote-integration';
const OIDC_TOKEN = 'oidc-for-mcp-remote-integration';
const EXTERNAL_MCP_BEARER = 'external-mcp-access-token';
const LOCAL_ENDPOINT_JWT = 'local-endpoint-jwt-that-must-not-cross-the-remote-hop';

@WpDto()
class RemoteRequest {
    @WpDtoField(new WpDtoFieldOptions('Search text', true))
    query!: string;

    constructor(query?: string) {
        if (query !== undefined) this.query = query;
    }
}

@WpDto()
class RemoteResponse {
    @WpDtoField(new WpDtoFieldOptions('Delegated user', true))
    user!: string;

    @WpDtoField(new WpDtoFieldOptions('Delegated roles', true))
    roles!: string;

    @WpDtoField(new WpDtoFieldOptions('Result', true))
    result!: string;

    constructor(user?: string, roles?: string, result?: string) {
        if (user !== undefined) this.user = user;
        if (roles !== undefined) this.roles = roles;
        if (result !== undefined) this.result = result;
    }
}

@ApiPath('/remote-mcp')
abstract class RemoteMcpApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({ name: 'remote_integration_search', description: 'Calls a remote Webpieces API.' })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@ApiPath('/missing-remote-mcp')
abstract class MissingRemoteMcpApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthOidc('mcp-gateway')
    @Endpoint('/search', 'rpc')
    @WpResponseDto(() => RemoteResponse)
    @WpMcpTool({
        name: 'missing_remote_integration_search',
        description: 'Intentionally absent route.',
    })
    search(_request: RemoteRequest): Promise<RemoteResponse> {
        throw new Error('contract only');
    }
}

@injectable()
class RemoteMcpController extends RemoteMcpApi {
    calls = 0;
    authorization?: string;

    override search(request: RemoteRequest): Promise<RemoteResponse> {
        this.calls += 1;
        this.authorization = RequestContext.getRequest()?.getHeader('authorization');
        return Promise.resolve(
            new RemoteResponse(
                RequestContext.getTrusted(REMOTE_USER) ?? 'missing-user',
                RequestContext.getTrusted(REMOTE_ROLES) ?? 'missing-roles',
                `remote:${request.query}`,
            ),
        );
    }
}

class RecordingOidcMinter {
    readonly audiences: string[] = [];

    mintIdToken(audience: string): Promise<string> {
        this.audiences.push(audience);
        return Promise.resolve(OIDC_TOKEN);
    }
}

class RecordingOidcVerifier extends OidcHook {
    readonly tokens: string[] = [];
    readonly callerLists: string[][] = [];

    override verifyOidc(token: string, callers: string[]): Promise<void> {
        this.tokens.push(token);
        this.callerLists.push(callers);
        if (token !== OIDC_TOKEN) throw new Error(`unexpected OIDC token '${token}'`);
        return Promise.resolve();
    }
}

class OutboundWireProbe extends Filter<ClientRequest, Response> {
    readonly authorizations: Array<string | undefined> = [];

    override async filter(
        request: ClientRequest,
        next: Service<ClientRequest, Response>,
    ): Promise<Response> {
        const response = await next.invoke(request);
        this.authorizations.push(request.headers.get('Authorization'));
        return response;
    }
}

@injectable()
class BoundaryProbeFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    calls = 0;
    sawLogIdentity = false;
    sawTrustedUser?: string;

    override filter(
        meta: MethodMeta,
        next: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        this.calls += 1;
        this.sawLogIdentity =
            RequestContext.getUntrusted(WebpiecesCoreHeaders.CONTROLLER) ===
                'RemoteMcpController' &&
            RequestContext.getUntrusted(WebpiecesCoreHeaders.METHOD) === 'search';
        this.sawTrustedUser = RequestContext.getTrusted(REMOTE_USER);
        return next.invoke(meta);
    }
}

describe('McpApiBinding.remote generated Node client integration', () => {
    let server: Server;
    let router: WebpiecesRouter;
    let controller: RemoteMcpController;
    let verifier: RecordingOidcVerifier;
    let boundary: BoundaryProbeFilter;
    let minter: RecordingOidcMinter;
    let outbound: OutboundWireProbe;
    let binding: McpApiBinding<RemoteMcpApi>;
    let missingBinding: McpApiBinding<MissingRemoteMcpApi>;
    let tool: RegisteredMcpTool;
    let baseUrl: string;

    beforeAll(async () => {
        HeaderRegistry.configure([REMOTE_USER, REMOTE_ROLES], true);
        ClientRegistry.clear();
        verifier = new RecordingOidcVerifier();
        boundary = new BoundaryProbeFilter();
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(OIDC_HOOK).toConstantValue(verifier);
            options.bind(RemoteMcpController).toSelf().inSingletonScope();
            options.bind(BoundaryProbeFilter).toConstantValue(boundary);
        });
        router = await WebpiecesRouterFactory.create({ appBindings: [bindings] });
        router.addRoutes(RemoteMcpApi, RemoteMcpController);
        router.addFilter(new FilterDefinition(100, BoundaryProbeFilter, '*'));
        controller = router.getContainer().get(RemoteMcpController);
        server = await new WebpiecesExpressRouter(router).bindAndStartExpress(express(), 0);
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('remote integration server has no port');
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
        ClientRegistry.addUrlMapping(REMOTE_SERVICE, baseUrl);

        minter = new RecordingOidcMinter();
        outbound = new OutboundWireProbe();
        const factory = new ClientHttpFactory(
            new Provider<NodeProxyClient>(
                () =>
                    new NodeProxyClient(
                        new RequestContextHeaders(),
                        minter as unknown as GcpOidc,
                        new DnsAddressResolver(),
                    ),
            ),
        );
        binding = McpApiBinding.remote(RemoteMcpApi, () =>
            factory.createRpcClient(RemoteMcpApi, new ClientConfig(REMOTE_SERVICE), [
                new ClientFilterDefinition(1_000, outbound),
            ]),
        );
        missingBinding = McpApiBinding.remote(MissingRemoteMcpApi, () =>
            factory.createRpcClient(MissingRemoteMcpApi, new ClientConfig(REMOTE_SERVICE), [
                new ClientFilterDefinition(1_000, outbound),
            ]),
        );
        tool = requiredTool(new McpToolRegistry([binding]), 'remote_integration_search');
        new McpToolRegistry([missingBinding]);
    });

    afterAll(async () => {
        ClientRegistry.clear();
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            server.close((error?: Error) => (error ? reject(error) : resolve()));
        });
    });

    it('mints OIDC and admits delegated MCP identity only after remote authentication', async () => {
        const credential = verifiedCredential();
        const invocation = new McpInvocationContext(
            'remote-call-1',
            tool.name,
            credential.subject,
            credential.listingRoles,
            new AbortController().signal,
        );
        const result = await new McpApiDispatcher().call(
            tool,
            new RemoteRequest('hello'),
            credential,
            invocation,
            LOCAL_ENDPOINT_JWT,
        );

        expect(result).toBeInstanceOf(McpDispatchSuccess);
        if (!(result instanceof McpDispatchSuccess)) return;
        expect(result.value).toEqual(
            new RemoteResponse('verified-user-7', 'reader,writer', 'remote:hello'),
        );
        expect(minter.audiences).toEqual([baseUrl]);
        expect(verifier.tokens).toEqual([OIDC_TOKEN]);
        expect(verifier.callerLists).toEqual([['mcp-gateway']]);
        expect(controller.authorization).toBe(`Bearer ${OIDC_TOKEN}`);
        expect(controller.authorization).not.toContain(EXTERNAL_MCP_BEARER);
        expect(controller.authorization).not.toContain(LOCAL_ENDPOINT_JWT);
        expect(outbound.authorizations).toEqual([`Bearer ${OIDC_TOKEN}`]);
        expect(boundary.calls).toBe(1);
        expect(boundary.sawLogIdentity).toBe(true);
        expect(boundary.sawTrustedUser).toBe('verified-user-7');
        expect(controller.calls).toBe(1);
    });

    it('names a missing remote route as this gateway implementation failure', async () => {
        const mintCount = minter.audiences.length;
        const verifyCount = verifier.tokens.length;
        await RequestContext.runDetachedScope(async () => {
            const incoming = new HttpRequest(
                'POST',
                '/__webpieces/mcp/missing_remote_integration_search',
                new Map<string, string[]>([['authorization', [`Bearer ${EXTERNAL_MCP_BEARER}`]]]),
            );
            new RequestContextHeaders().fillFromRequest(incoming);
            RequestContext.putTrusted(REMOTE_USER, 'verified-user-7');
            RequestContext.putTrusted(REMOTE_ROLES, 'reader,writer');
            await expect(
                missingBinding.invoke('search', new RemoteRequest('missing')),
            ).rejects.toThrow(/dependency answered HTTP 404.*check the path, the base URL/);
        });

        expect(minter.audiences).toHaveLength(mintCount + 1);
        expect(verifier.tokens).toHaveLength(verifyCount);
        expect(outbound.authorizations.at(-1)).toBe(`Bearer ${OIDC_TOKEN}`);
        expect(controller.calls).toBe(1);
    });
});

function verifiedCredential(): VerifiedMcpCredential {
    const now = Math.floor(Date.now() / 1000);
    return new VerifiedMcpCredential(
        'mcp-user-7',
        'https://issuer.example.test',
        'https://gateway.example.test/mcp',
        now,
        now + 60,
        ['tools'],
        now,
        ['reader', 'writer'],
        [
            new ContextTuple(REMOTE_USER, 'verified-user-7'),
            new ContextTuple(REMOTE_ROLES, 'reader,writer'),
        ],
    );
}

function requiredTool(registry: McpToolRegistry, name: string): RegisteredMcpTool {
    const found = registry.find(name);
    if (!found) throw new Error(`MCP integration fixture did not register '${name}'.`);
    return found;
}
