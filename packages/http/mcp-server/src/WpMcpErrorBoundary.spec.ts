import 'reflect-metadata';
import { Server } from 'node:http';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiPath,
    Endpoint,
    HeaderRegistry,
    LoggerFactory,
    LogManager,
    WpAuthJwt,
    WpDto,
    WpDtoField,
    WpDtoFieldOptions,
    WpDtoMapFieldOptions,
    WpMcpAuthJwt,
    WpMcpTool,
    WpResponseDto,
} from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory } from '@webpieces/http-routing';
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
import {
    ENDPOINT_PATH,
    RecordedLogLine,
    RecordingLoggerFactory,
    SearchApi,
    SearchController,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

@WpDto()
class PassageSentence {
    @WpDtoField(new WpDtoFieldOptions('Sentence text', true))
    text!: string;

    @WpDtoField(
        new WpDtoMapFieldOptions('ISO 639-1 -> this sentence in that language', false, 'string'),
    )
    translations?: Record<string, string>;
}

@WpDto()
class PassageRequest {
    @WpDtoField(new WpDtoMapFieldOptions('Requested word counts by locale', false, 'integer'))
    minWordsByLocale?: Record<string, number>;
}

@WpDto()
class PassageResponse {
    @WpDtoField(new WpDtoMapFieldOptions('Sentences by locale', true, PassageSentence))
    sentencesByLocale!: Record<string, PassageSentence>;
}

@ApiPath('/mcp-spec-passages')
abstract class PassageApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/passages', 'rpc')
    @WpResponseDto(() => PassageResponse)
    @WpMcpTool({
        name: 'passages_find',
        description: 'Find passages with their translations keyed by locale.',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
    })
    passages(_request: PassageRequest): Promise<PassageResponse> {
        throw new Error('contract only');
    }
}

@injectable()
class PassageController extends PassageApi {
    override async passages(request: PassageRequest): Promise<PassageResponse> {
        const sentence = new PassageSentence();
        sentence.text = 'hello';
        sentence.translations = { es: 'hola', fr: 'bonjour' };
        const response = new PassageResponse();
        response.sentencesByLocale = { en: sentence };
        if (request.minWordsByLocale?.['xx'] !== undefined) {
            const broken = new PassageSentence();
            broken.text = 'broken';
            // Deliberately violate the map value type to prove output validation walks map values.
            Object.defineProperty(broken, 'translations', { value: { es: 7 }, enumerable: true });
            response.sentencesByLocale = { xx: broken };
        }
        return response;
    }
}

describe('WpMcpServer error boundary (WpMcpErrorTranslator)', () => {
    let bridge: WpMcpServer<string, string>;
    let authority: TestTokenAuthority;
    let jwtHook: TestJwtHook;
    let httpServer: Server;
    let harness: McpHttpTestHarness;
    let logs: RecordingLoggerFactory;
    let originalLoggerFactory: LoggerFactory;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        originalLoggerFactory = LogManager.getFactory();
        logs = new RecordingLoggerFactory();
        LogManager.setFactory(logs);
        jwtHook = new TestJwtHook();
        const module = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        const router = await WebpiecesRouterFactory.create({ appBindings: [module] });
        router.addRoutes(SearchApi, SearchController);
        router.addRoutes(PassageApi, PassageController);
        authority = new TestTokenAuthority();
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string, string>()
                .setName('boundary-server')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/app-owned/mcp')
                .setAccessTokenAuthority(authority)
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
                [McpApiBinding.local(SearchApi, router), McpApiBinding.local(PassageApi, router)],
                McpDeployment.singleProcess(),
            ),
        );
        httpServer = await TestServers.listen(app);
        harness = new McpHttpTestHarness(TestServers.urlOf(httpServer), ENDPOINT_PATH);
    });

    afterAll(async () => {
        LogManager.setFactory(originalLoggerFactory);
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
        body: Record<string, unknown> | string,
        token: string | null = 'mcp-user',
    ): Promise<McpPostReply> {
        return harness.post(body, token);
    }

    async function callTool(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
        return harness.callTool(name, args);
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

    it('sanitizes implementation errors but preserves explicit model-safe errors', async () => {
        const internal = await callTool('account_search', { query: 'internal' });
        const human = await callTool('account_search', { query: 'human' });
        expect(JSON.stringify(internal)).not.toContain('database password');
        const implementation = modelErrorOf(internal);
        expect(implementation['kind']).toBe('implementation');
        expect(implementation['message']).toContain('Internal error in tool account_search');
        expect(implementation['message']).toContain(
            `requestId ${String(implementation['requestId'])}`,
        );
        expect(implementation['message']).toContain('bug in the tool, not in your arguments');
        expect(modelErrorOf(human)).toMatchObject({
            kind: 'end-user',
            message: 'Safe human message',
            errorCode: 'SAFE',
        });
    });

    /**
     * THE TRAP (#959). `ApiConnectionError` IS an `ApiError`, so encoding the thrown value naively
     * would publish kind `connection` to the model. A downstream call of OURS failing is this
     * server's own bug: it must stay `implementation`, with the generic implementation text, and
     * the downstream host must not reach the model.
     */
    it('renders a caller-local connection failure as implementation, never as kind connection', async () => {
        logs.lines.length = 0;

        const reply = await callTool('account_search', { query: 'downstream' });

        const visible = modelErrorOf(reply);
        expect(visible['kind']).toBe('implementation');
        expect(visible['message']).toContain('Internal error in tool account_search');
        expect(visible['message']).toContain('bug in the tool, not in your arguments');
        expect(JSON.stringify(reply)).not.toContain('private-host');
        expect(JSON.stringify(reply)).not.toContain('connection');
        // Exactly one boundary line, and it still names the class that actually failed.
        const lines = logs.containing(
            '[name=ApiConnectionError kind=implementation subType=none] ' +
                'ECONNREFUSED private-host:8443',
        );
        expect(lines).toHaveLength(1);
        expect(lines[0].level).toBe('error');
        expect(lines[0].logger).toBe('WpMcpErrorTranslator');
        expect(logs.containing('name=ApiImplementationError')).toHaveLength(0);
    });

    it('rejects unknown tools and caller-injected fields before dispatch', async () => {
        const unknown = await post(request('tools/call', { name: 'not_a_tool', arguments: {} }));
        expect(unknown.response.status).toBe(200);
        expect(unknown.payload.error).toMatchObject({
            code: -32_602,
            message: 'Unknown tool: not_a_tool',
        });
        expect(unknown.payload.error?.data?.['requestId']).toEqual(expect.any(String));
        const injected = await callTool('account_search', { query: 'mine', userId: 'admin-7' });
        expect(modelErrorOf(injected)).toMatchObject({
            kind: 'bad-request',
            field: '$.userId',
            callerMessage: '$.userId is not allowed',
        });
        expect(JSON.stringify(injected)).not.toContain('admin-7');
    });

    it('publishes, calls and reads back a tool whose request and response carry typed maps', async () => {
        const listed = resultOf((await post(request('tools/list'))).payload)['tools'] as Array<
            Record<string, unknown>
        >;
        const tool = listed.find(
            (candidate: Record<string, unknown>) => candidate['name'] === 'passages_find',
        );
        expect(tool).toMatchObject({
            inputSchema: {
                properties: {
                    minWordsByLocale: { type: 'object', additionalProperties: { type: 'integer' } },
                },
            },
            outputSchema: {
                required: ['sentencesByLocale'],
                properties: {
                    sentencesByLocale: {
                        type: 'object',
                        additionalProperties: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                translations: {
                                    type: 'object',
                                    additionalProperties: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        });
        const result = await callTool('passages_find', { minWordsByLocale: { es: 3 } });
        const badInput = await callTool('passages_find', { minWordsByLocale: { es: 'three' } });
        const badOutput = await callTool('passages_find', { minWordsByLocale: { xx: 1 } });
        expect(structuredOf(result)).toEqual({
            sentencesByLocale: {
                en: { text: 'hello', translations: { es: 'hola', fr: 'bonjour' } },
            },
        });
        expect(modelErrorOf(badInput)).toMatchObject({
            kind: 'bad-request',
            field: '$.minWordsByLocale.es',
            callerMessage: '$.minWordsByLocale.es must be integer',
        });
        expect(modelErrorOf(badOutput)).toMatchObject({ kind: 'implementation' });
        expect(JSON.stringify(badOutput)).not.toContain('"es":7');
    });

    it('gives the model callerMessage and field for a bad request, never its operator message', async () => {
        const reply = await callTool('account_search', { query: 'malformed' });
        expect(modelErrorOf(reply)).toMatchObject({
            kind: 'bad-request',
            message: 'query is malformed',
            callerMessage: 'query is malformed',
            field: '$.query',
        });
        expect(JSON.stringify(reply)).not.toContain('operator-only');
        expect(JSON.stringify(reply)).not.toContain('tenant_7');
    });

    it('attaches the requestId to success, end-user, bad-request and implementation results', async () => {
        const success = resultOf(await callTool('account_search', { query: 'mine' }));
        const meta = success['_meta'] as Record<string, unknown> | undefined;
        expect(meta?.['webpieces/requestId']).toEqual(expect.stringMatching(/\S+/));
        expect(success['structuredContent']).not.toHaveProperty('requestId');
        for (const query of ['human', 'malformed', 'internal']) {
            const reply = await callTool('account_search', { query });
            const visible = modelErrorOf(reply);
            expect(visible['requestId']).toEqual(expect.stringMatching(/\S+/));
            const errorMeta = resultOf(reply)['_meta'] as Record<string, unknown> | undefined;
            expect(errorMeta?.['webpieces/requestId']).toBe(visible['requestId']);
        }
        const listFailure = await post(request('tools/list'), 'list-bug');
        expect(listFailure.payload.error?.data?.['requestId']).toEqual(
            expect.stringMatching(/\S+/),
        );
    });

    function secretLines(): RecordedLogLine[] {
        return logs.containing('SECRET-internal-detail');
    }

    it('never leaks a raw bind-boundary exception and logs it exactly once with correlation', async () => {
        logs.lines.length = 0;
        const body = request('tools/list');
        const reply = await post(body, 'authority-bug');
        expect(reply.response.status).toBe(500);
        expect(reply.payload.error).toMatchObject({ code: -32_603, message: 'Internal Error' });
        expect(JSON.stringify(reply.payload)).not.toContain('SECRET');
        const lines = secretLines();
        expect(lines).toHaveLength(1);
        expect(lines[0].level).toBe('error');
        expect(lines[0].message).toContain(`jsonRpcId=${String(body['id'])}`);
        expect(lines[0].message).toMatch(/requestId=\S+/);
        expect(lines[0].message).toContain('method=tools/list');
    });

    it('never leaks a raw tools/list exception and answers a generic JSON-RPC internal error', async () => {
        logs.lines.length = 0;
        const body = request('tools/list');
        const reply = await post(body, 'list-bug');
        expect(reply.response.status).toBe(200);
        expect(reply.payload.error).toMatchObject({ code: -32_603, message: 'Internal Error' });
        expect(JSON.stringify(reply.payload)).not.toContain('SECRET');
        const lines = secretLines();
        expect(lines).toHaveLength(1);
        expect(lines[0].level).toBe('error');
        expect(lines[0].message).toContain(`jsonRpcId=${String(body['id'])}`);
        expect(lines[0].message).toContain('method=tools/list');
    });

    it('never leaks a raw tools/call exception and logs it exactly once with the tool name', async () => {
        logs.lines.length = 0;
        const body = request('tools/call', {
            name: 'account_search',
            arguments: { query: 'mine' },
        });
        jwtHook.failWith = new Error('SECRET-internal-detail');
        const reply = await post(body);
        jwtHook.failWith = undefined;
        expect(JSON.stringify(reply.payload)).not.toContain('SECRET');
        expect(modelErrorOf(reply.payload)).toMatchObject({ kind: 'implementation' });
        const lines = secretLines();
        expect(lines).toHaveLength(1);
        expect(lines[0].level).toBe('error');
        expect(lines[0].message).toContain(`jsonRpcId=${String(body['id'])}`);
        expect(lines[0].message).toContain('tool=account_search');
        expect(lines[0].message).toMatch(/requestId=\S+/);
    });

    it('answers 401 with WWW-Authenticate for missing or rejected bearers, never -32603', async () => {
        const missing = await post(request('tools/list'), null);
        expect(missing.response.status).toBe(401);
        // The value is the RFC 9728 METADATA DOCUMENT url, never the resource identifier itself.
        expect(missing.response.headers.get('www-authenticate')).toBe(
            'Bearer resource_metadata=' +
                '"https://api.example.test/.well-known/oauth-protected-resource/app-owned/mcp"',
        );
        const rejected = await post(request('tools/list'), 'invalid');
        expect(rejected.response.status).toBe(401);
        expect(rejected.response.headers.get('www-authenticate')).toContain('Bearer');
        expect(rejected.payload.error?.code).toBe(-32_000);
    });

    it('verifies the external bearer exactly once per POST', async () => {
        const before = authority.verificationCount;
        await callTool('account_search', { query: 'mine' });
        await post(request('tools/list'));
        expect(authority.verificationCount - before).toBe(2);
    });

    it('answers a malformed JSON body with HTTP 400, not the SDK parse-error fallback', async () => {
        const reply = await post('{"jsonrpc": "2.0", ');
        expect(reply.response.status).toBe(400);
        expect(reply.payload.error).toMatchObject({ code: -32_700, message: 'Bad Request' });
    });
});
