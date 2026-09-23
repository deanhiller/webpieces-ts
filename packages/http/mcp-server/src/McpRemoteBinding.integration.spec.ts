import 'reflect-metadata';
import { Server } from 'node:http';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ClientRegistry,
    ContextTuple,
    Filter,
    HeaderRegistry,
    LoggerFactory,
    LogManager,
    Service,
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
    JWT_HOOK,
    OIDC_HOOK,
    WebpiecesRouter,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
// eslint-disable-next-line @webpieces/enforce-architecture -- test-only downstream server fixture; mcp-server production remains transport-level independent
import { WebpiecesExpressRouter } from '@webpieces/http-server';
import { McpApiBinding } from './McpApiBinding';
import { McpApiDispatcher } from './McpApiDispatcher';
import { VerifiedMcpCredential, WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpInvocationContext } from './McpInvocationContext';
import { McpToolRegistry, RegisteredMcpTool } from './McpToolRegistry';
import { WpMcpServer } from './WpMcpServer';
import { TestServers } from './__tests__/McpHttpTestHarness';
import {
    BoundaryProbeFilter,
    EXTERNAL_MCP_BEARER,
    GARBAGE_SERVICE,
    GarbageRemoteApi,
    GATEWAY_PATH,
    LOCAL_ENDPOINT_JWT,
    LocalThrowApi,
    LocalThrowController,
    MissingRemoteMcpApi,
    OIDC_TOKEN,
    OidcFailRemoteApi,
    RecordingOidcMinter,
    RecordingOidcVerifier,
    REFUSED_SERVICE,
    RefusedRemoteApi,
    RelayWebpiecesPeerErrors,
    REMOTE_ROLES,
    REMOTE_SERVICE,
    GATEWAY_CATALOGS,
    REMOTE_MCP_CATALOG,
    REMOTE_USER,
    RemoteMcpApi,
    RemoteMcpController,
    RemoteRequest,
    RemoteResponse,
    RemoteThrowApi,
    RemoteThrowController,
    THROW_CASES,
    ThrowCase,
} from './__tests__/McpRemoteFixtures';
import {
    MODERN_VERSION,
    RecordedLogLine,
    RecordingLoggerFactory,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

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

interface ToolReply {
    result?: {
        isError?: boolean;
        content?: Array<{ type: string; text: string }>;
        _meta?: Record<string, unknown>;
    };
    error?: { code: number; message: string };
}

describe('McpApiBinding.remote generated Node client integration', () => {
    let server: Server;
    let garbageServer: Server;
    let gatewayServer: Server;
    let gateway: WpMcpServer<string, string>;
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
    let gatewayUrl: string;
    let logs: RecordingLoggerFactory;
    let originalLoggerFactory: LoggerFactory;
    let nextId = 0;
    const relay = new RelayWebpiecesPeerErrors();

    beforeAll(async () => {
        HeaderRegistry.configure([REMOTE_USER, REMOTE_ROLES, USER_ID], true);
        originalLoggerFactory = LogManager.getFactory();
        logs = new RecordingLoggerFactory();
        LogManager.setFactory(logs);
        ClientRegistry.resetForTests();
        ClientRegistry.setErrorTranslator(relay);
        const jwtHook = new TestJwtHook();
        await startDownstream(jwtHook);
        await startFailureServers();
        minter = new RecordingOidcMinter();
        outbound = new OutboundWireProbe();
        const factory = clientFactory(minter);
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
        tool = requiredTool(
            new McpToolRegistry([binding], [REMOTE_MCP_CATALOG]),
            'remote_integration_search',
        );
        await startGateway(jwtHook, factory);
    });

    async function startDownstream(jwtHook: TestJwtHook): Promise<void> {
        verifier = new RecordingOidcVerifier();
        boundary = new BoundaryProbeFilter();
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(OIDC_HOOK).toConstantValue(verifier);
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
            options.bind(RemoteMcpController).toSelf().inSingletonScope();
            options.bind(BoundaryProbeFilter).toConstantValue(boundary);
        });
        router = await WebpiecesRouterFactory.create({ appBindings: [bindings] });
        router.addRoutes(RemoteMcpApi, RemoteMcpController);
        router.addRoutes(LocalThrowApi, LocalThrowController);
        router.addRoutes(RemoteThrowApi, RemoteThrowController);
        router.addFilter(new FilterDefinition(100, BoundaryProbeFilter, '*'));
        controller = router.getContainer().get(RemoteMcpController);
        server = await new WebpiecesExpressRouter(router).bindAndStartExpress(express(), 0);
        baseUrl = TestServers.urlOf(server);
        ClientRegistry.addUrlMapping(REMOTE_SERVICE, baseUrl);
    }

    async function startFailureServers(): Promise<void> {
        const refused = await TestServers.listen(express());
        ClientRegistry.addUrlMapping(REFUSED_SERVICE, TestServers.urlOf(refused));
        await TestServers.close(refused);
        const garbageApp = express();
        garbageApp.use((_req: express.Request, res: express.Response): void => {
            res.status(418).type('html').send('<html>SECRET-garbage-internals</html>');
        });
        garbageServer = await TestServers.listen(garbageApp);
        ClientRegistry.addUrlMapping(GARBAGE_SERVICE, TestServers.urlOf(garbageServer));
    }

    async function startGateway(jwtHook: TestJwtHook, factory: ClientHttpFactory): Promise<void> {
        const failingOidc = clientFactory(
            new RecordingOidcMinter(new Error('SECRET-oidc-metadata-server-down')),
        );
        gateway = new WpMcpServer(
            new WpMcpServerConfig<string, string>()
                .setName('gateway')
                .setVersion('1.0.0')
                .setResource('https://gateway.example.test/gateway/mcp')
                .setAccessTokenAuthority(new TestTokenAuthority())
                .setEndpointJwtAuthority(jwtHook)
                .setEndpointMintRequest((credential: VerifiedMcpCredential) => credential.subject)
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools']),
        );
        const gatewayApp: Express = express();
        gateway.bind(
            gatewayApp,
            new McpBindOptions(
                GATEWAY_PATH,
                [
                    McpApiBinding.local(LocalThrowApi, router),
                    McpApiBinding.remote(RemoteThrowApi, () =>
                        factory.createRpcClient(RemoteThrowApi, new ClientConfig(REMOTE_SERVICE)),
                    ),
                    missingBinding,
                    McpApiBinding.remote(RefusedRemoteApi, () =>
                        factory.createRpcClient(
                            RefusedRemoteApi,
                            new ClientConfig(REFUSED_SERVICE),
                        ),
                    ),
                    McpApiBinding.remote(GarbageRemoteApi, () =>
                        factory.createRpcClient(
                            GarbageRemoteApi,
                            new ClientConfig(GARBAGE_SERVICE),
                        ),
                    ),
                    McpApiBinding.remote(OidcFailRemoteApi, () =>
                        failingOidc.createRpcClient(
                            OidcFailRemoteApi,
                            new ClientConfig(REMOTE_SERVICE),
                        ),
                    ),
                ],
                GATEWAY_CATALOGS,
                McpDeployment.singleProcess(),
            ),
        );
        gatewayServer = await TestServers.listen(gatewayApp);
        gatewayUrl = TestServers.urlOf(gatewayServer);
    }

    afterAll(async () => {
        LogManager.setFactory(originalLoggerFactory);
        ClientRegistry.resetForTests();
        await gateway.close();
        await TestServers.close(gatewayServer);
        await TestServers.close(garbageServer);
        await TestServers.close(server);
    });

    function clientFactory(oidc: RecordingOidcMinter): ClientHttpFactory {
        return new ClientHttpFactory(
            new Provider<NodeProxyClient>(
                () =>
                    new NodeProxyClient(
                        new RequestContextHeaders(),
                        oidc as unknown as GcpOidc,
                        new DnsAddressResolver(),
                    ),
            ),
        );
    }

    async function callGateway(toolName: string, query: string): Promise<ToolReply> {
        const body = {
            jsonrpc: '2.0',
            id: ++nextId,
            method: 'tools/call',
            params: {
                name: toolName,
                arguments: { query },
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
                    [CLIENT_INFO_META_KEY]: { name: 'webpieces-integration', version: '1.0.0' },
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                },
            },
        };
        const response = await fetch(`${gatewayUrl}${GATEWAY_PATH}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer mcp-user',
                accept: 'application/json',
                'content-type': 'application/json',
                'mcp-protocol-version': MODERN_VERSION,
                'mcp-method': 'tools/call',
                'mcp-name': toolName,
            },
            body: JSON.stringify(body),
        });
        return (await response.json()) as ToolReply;
    }

    /** The model-visible payload with the per-call requestId and the tool name made comparable. */
    function modelVisible(reply: ToolReply, toolName: string): Record<string, unknown> {
        expect(reply.error).toBeUndefined();
        expect(reply.result?.isError).toBe(true);
        const text = reply.result?.content?.[0]?.text ?? '';
        const envelope = JSON.parse(text) as Record<string, unknown>;
        expect(Object.keys(envelope)).toEqual(['error']);
        const payload = envelope['error'] as Record<string, unknown>;
        const requestId = String(payload['requestId']);
        expect(reply.result?._meta?.['webpieces/requestId']).toBe(requestId);
        const normalized = text.split(requestId).join('<requestId>').split(toolName).join('<tool>');
        return (JSON.parse(normalized) as Record<string, Record<string, unknown>>)['error'];
    }

    /**
     * The operator lines one API call produced, counted across ALL loggers rather than filtered to
     * one — which is what #961 item 5 is about: `ApiErrorBoundary.logOperatorDetail` used to add a
     * second, barer line beside `LogApiCall`'s, and filtering by logger name is exactly how that
     * stayed invisible.
     */
    function failureLines(apiClass: string, side: 'server' | 'client'): RecordedLogLine[] {
        return logs.lines.filter(
            (line: RecordedLogLine) =>
                line.message.includes(`[API-${side}-resp-`) &&
                !line.message.includes('SUCCESS') &&
                line.message.includes(`] ${apiClass}.`),
        );
    }

    function oneFailureLine(apiClass: string, side: 'server' | 'client'): RecordedLogLine {
        const lines = failureLines(apiClass, side);
        expect(lines).toHaveLength(1);
        return lines[0];
    }

    it('mints OIDC and admits delegated MCP identity only after remote authentication', async () => {
        const credential = verifiedCredential();
        const invocation = new McpInvocationContext(
            'remote-call-1',
            tool.name,
            credential.subject,
            credential.listingRoles,
            new AbortController().signal,
        );
        const value = await RequestContext.run(async () =>
            new McpApiDispatcher().call(
                tool,
                new RemoteRequest('hello'),
                credential,
                invocation,
                LOCAL_ENDPOINT_JWT,
            ),
        );

        expect(value).toEqual(
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
            ).rejects.toThrow(/dependency answered 404.*check the path, the base URL/);
        });

        expect(minter.audiences).toHaveLength(mintCount + 1);
        expect(verifier.tokens).toHaveLength(verifyCount);
        expect(outbound.authorizations.at(-1)).toBe(`Bearer ${OIDC_TOKEN}`);
        expect(controller.calls).toBe(1);
    });

    it('rejects delegated identity context from a caller that fails remote OIDC', async () => {
        const forging = clientFactory(new RecordingOidcMinter(undefined, 'forged-oidc-token'));
        const client = forging.createRpcClient(RemoteMcpApi, new ClientConfig(REMOTE_SERVICE));
        const callsBefore = controller.calls;
        await RequestContext.run(async () => {
            const incoming = new HttpRequest('POST', '/forged', new Map<string, string[]>());
            new RequestContextHeaders().fillFromRequest(incoming);
            RequestContext.putTrusted(REMOTE_USER, 'forged-admin');
            RequestContext.putTrusted(REMOTE_ROLES, 'admin');
            await expect(client.search(new RemoteRequest('forged'))).rejects.toBeInstanceOf(Error);
        });
        expect(verifier.tokens.at(-1)).toBe('forged-oidc-token');
        expect(controller.calls).toBe(callsBefore);
        expect(boundary.sawTrustedUser).not.toBe('forged-admin');
    });

    it.each(THROW_CASES.map((throwCase: ThrowCase) => [throwCase.name, throwCase]))(
        'translates %s identically through a local and a remote binding',
        async (_name: string, throwCase: ThrowCase) => {
            logs.lines.length = 0;
            const local = modelVisible(
                await callGateway('local_throw', throwCase.name),
                'local_throw',
            );
            const remote = modelVisible(
                await callGateway('remote_throw', throwCase.name),
                'remote_throw',
            );
            expect(remote).toEqual(local);
            expect(local['kind']).toBe(throwCase.expectedKind);
            expect(JSON.stringify(local)).not.toContain('internals');
            // ONE line for the in-process binding: the filter's, and nothing from the MCP edge.
            expect(oneFailureLine('LocalThrowApi', 'server').level).toBe(
                throwCase.expectedServerLevel,
            );
            // The remote binding is TWO calls, so it has one line per HOP and still none from the
            // MCP edge: the remote server's own, plus the gateway client's report of its call.
            expect(oneFailureLine('RemoteThrowApi', 'server').level).toBe(
                throwCase.expectedServerLevel,
            );
            expect(failureLines('RemoteThrowApi', 'client')).toHaveLength(1);
        },
    );

    it('gives the model a coded status and errorCode after the remote hop', async () => {
        const remote = modelVisible(await callGateway('remote_throw', 'coded-4xx'), 'remote_throw');
        expect(remote).toMatchObject({
            kind: 'coded',
            message: 'Request Failed',
            errorCode: 'QUOTA',
            statusCode: 460,
        });
    });

    it('gives the model an end-user message byte-for-byte after the remote hop', async () => {
        const remote = modelVisible(await callGateway('remote_throw', 'end-user'), 'remote_throw');
        expect(remote).toMatchObject({
            kind: 'end-user',
            message: 'The two passwords you entered do not match.',
            errorCode: 'PW_MISMATCH',
        });
        const backoff = modelVisible(
            await callGateway('remote_throw', 'dependency-backoff'),
            'remote_throw',
        );
        expect(backoff).toMatchObject({ kind: 'dependency-backoff', retryAfterSeconds: 42 });
        const badRequest = modelVisible(
            await callGateway('remote_throw', 'bad-request'),
            'remote_throw',
        );
        expect(badRequest).toMatchObject({
            kind: 'bad-request',
            message: 'query must be a word',
            field: '$.query',
        });
    });

    it('keeps a remote 4xx as the gateway implementation failure without the relay opt-out', async () => {
        relay.relay = false;
        const remote = modelVisible(await callGateway('remote_throw', 'forbidden'), 'remote_throw');
        relay.relay = true;
        expect(remote['kind']).toBe('implementation');
    });

    it.each([
        ['connection refused', 'refused_remote'],
        ['an undecodable remote body', 'garbage_remote'],
        ['an OIDC token-mint failure', 'oidc_fail_remote'],
        ['a remote endpoint missing', 'missing_remote_integration_search'],
    ])(
        'turns %s into an implementation isError result, disclosing nothing',
        async (_label: string, toolName: string) => {
            logs.lines.length = 0;
            const visible = modelVisible(await callGateway(toolName, 'anything'), toolName);
            expect(visible['kind']).toBe('implementation');
            expect(visible['message']).toContain('internal bug');
            expect(JSON.stringify(visible)).not.toContain('SECRET');
        },
    );
});

function verifiedCredential(): VerifiedMcpCredential {
    const now = Math.floor(Date.now() / 1000);
    return new VerifiedMcpCredential(
        'mcp-user-7',
        'https://issuer.example.test',
        'https://gateway.example.test/gateway/mcp',
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
