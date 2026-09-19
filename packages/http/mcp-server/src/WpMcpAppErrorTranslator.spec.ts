import 'reflect-metadata';
import { Server } from 'node:http';
import express, { Express } from 'express';
import { CallToolResult } from '@modelcontextprotocol/server';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { McpErrorTranslators, McpFailureScope } from './WpMcpErrorTranslator';
import { McpHttpTestHarness, RpcResponse, TestServers } from './__tests__/McpHttpTestHarness';
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

/** An application error class with an application meaning webpieces knows nothing about. */
class PassageLockedError extends Error {
    constructor(public readonly passageId: string) {
        super(`passage ${passageId} is locked`);
    }
}

@WpDto()
class LockRequest {
    @WpDtoField(new WpDtoFieldOptions('Passage identifier', true))
    passageId!: string;
}

@WpDto()
class LockResponse {
    @WpDtoField(new WpDtoFieldOptions('Whether the passage is open', true))
    open!: boolean;
}

@ApiPath('/lock-spec')
abstract class LockApi {
    @WpMcpAuthJwt({ allRolesAllowed: true })
    @WpAuthJwt({ allRolesAllowed: true })
    @Endpoint('/open', 'rpc')
    @WpResponseDto(() => LockResponse)
    @WpMcpTool({
        name: 'passage_open',
        description: 'Open a passage for editing.',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    })
    open(_request: LockRequest): Promise<LockResponse> {
        throw new Error('contract only');
    }
}

@injectable()
class LockController extends LockApi {
    override async open(request: LockRequest): Promise<LockResponse> {
        if (request.passageId === 'locked') throw new PassageLockedError('locked');
        if (request.passageId === 'meta-owned') throw new PassageLockedError('meta-owned');
        if (request.passageId === 'translator-bug') throw new PassageLockedError('translator-bug');
        if (request.passageId === 'unclaimed') throw new Error('SECRET-operator-only-detail');
        return { open: true };
    }
}

/** What an application registers: it claims its own taxonomy and declines everything else. */
class LockErrorTranslators implements McpErrorTranslators {
    calls = 0;
    seenScopes: McpFailureScope[] = [];

    toToolResult(error: Error, scope: McpFailureScope): CallToolResult | undefined {
        this.calls += 1;
        this.seenScopes.push(scope);
        if (!(error instanceof PassageLockedError)) return undefined;
        if (error.passageId === 'translator-bug') throw new Error('SECRET-translator-bug');
        const structured = { passageId: error.passageId, action: 'ask_the_user_to_unlock' };
        const result: CallToolResult = {
            content: [{ type: 'text', text: `Passage ${error.passageId} is locked.` }],
            structuredContent: structured,
            isError: true,
        };
        if (error.passageId === 'meta-owned') result._meta = { 'lang/ownMeta': 'mine' };
        return result;
    }
}

describe('application-owned tools/call error translation', () => {
    let bridge: WpMcpServer<string, string>;
    let httpServer: Server;
    let harness: McpHttpTestHarness;
    let translators: LockErrorTranslators;
    let authority: TestTokenAuthority;
    let logs: RecordingLoggerFactory;
    let originalLoggerFactory: LoggerFactory;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        originalLoggerFactory = LogManager.getFactory();
        logs = new RecordingLoggerFactory();
        LogManager.setFactory(logs);
        const jwtHook = new TestJwtHook();
        const module = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        const router = await WebpiecesRouterFactory.create({ appBindings: [module] });
        router.addRoutes(LockApi, LockController);
        router.addRoutes(SearchApi, SearchController);
        authority = new TestTokenAuthority();
        translators = new LockErrorTranslators();
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string, string>()
                .setName('translator-server')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/mcp')
                .setAccessTokenAuthority(authority)
                .setEndpointJwtAuthority(jwtHook)
                .setEndpointMintRequest((credential: VerifiedMcpCredential) => credential.subject)
                .setAuthorizationServers(['https://login.example.test'])
                .setRequiredScopes(['tools'])
                .setErrorTranslator(translators),
        );
        const app: Express = express();
        bridge.bind(
            app,
            new McpBindOptions(
                ENDPOINT_PATH,
                [McpApiBinding.local(LockApi, router), McpApiBinding.local(SearchApi, router)],
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

    beforeEach(() => {
        translators.calls = 0;
        translators.seenScopes = [];
        logs.lines.length = 0;
    });

    async function open(passageId: string): Promise<RpcResponse> {
        return harness.callTool('passage_open', { passageId });
    }

    /** Only the boundary's own lines; the router's filters log the same failure on their own. */
    function boundaryLines(text: string): RecordedLogLine[] {
        return logs
            .containing(text)
            .filter((line: RecordedLogLine) => line.logger === 'WpMcpErrorTranslator');
    }

    it('a claimed error owns the ENTIRE tool result, structuredContent included', async () => {
        const result = harness.resultOf(await open('locked'));
        expect(result['isError']).toBe(true);
        expect(result['structuredContent']).toEqual({
            passageId: 'locked',
            action: 'ask_the_user_to_unlock',
        });
        expect(result['content']).toEqual([{ type: 'text', text: 'Passage locked is locked.' }]);
    });

    it('webpieces default-fills the requestId _meta when the app left _meta off', async () => {
        const result = harness.resultOf(await open('locked'));
        const meta = result['_meta'] as Record<string, unknown>;
        expect(typeof meta['webpieces/requestId']).toBe('string');
        expect(String(meta['webpieces/requestId']).length).toBeGreaterThan(0);
    });

    it('an app that set _meta keeps its own, and webpieces adds no requestId', async () => {
        const result = harness.resultOf(await open('meta-owned'));
        const meta = result['_meta'] as Record<string, unknown>;
        expect(meta['lang/ownMeta']).toBe('mine');
        expect(meta['webpieces/requestId']).toBeUndefined();
    });

    it('declining leaves the webpieces default rendering byte-for-byte unchanged', async () => {
        const payload = await open('unclaimed');
        expect(translators.calls).toBe(1);
        const visible = harness.modelErrorOf(payload);
        expect(visible['kind']).toBe('implementation');
        expect(JSON.stringify(payload)).not.toContain('SECRET-operator-only-detail');
        expect(String(visible['message'])).toContain('passage_open');
    });

    it('logs the operator detail exactly once even when the app renders the reply', async () => {
        await open('locked');
        const failures = boundaryLines('passage locked is locked');
        expect(failures).toHaveLength(1);
        expect(failures[0]?.level).toBe('error');
    });

    it('a translator that throws is reported and the ORIGINAL error still renders', async () => {
        const payload = await open('translator-bug');
        const visible = harness.modelErrorOf(payload);
        expect(visible['kind']).toBe('implementation');
        expect(JSON.stringify(payload)).not.toContain('SECRET-translator-bug');
        expect(boundaryLines('Application McpErrorTranslators.toToolResult threw')).toHaveLength(1);
        // the original failure is still the one the operator sees reported first
        expect(boundaryLines('passage translator-bug is locked')).toHaveLength(1);
    });

    it('the scope handed to the app carries the requestId and tool name', async () => {
        await open('locked');
        const scope = translators.seenScopes[0];
        expect(scope?.method).toBe('tools/call');
        expect(scope?.toolName).toBe('passage_open');
        expect(scope?.requestId.length).toBeGreaterThan(0);
    });

    it('tools/list stays framework-owned: the app translator is never consulted', async () => {
        const reply = await harness.post(harness.request('tools/list'), 'list-bug');
        expect(reply.payload.error?.code).toBe(-32_603);
        expect(reply.payload.error?.message).toBe('Internal Error');
        expect(translators.calls).toBe(0);
    });

    it('the pre-SDK HTTP boundary still answers 401 + WWW-Authenticate for OAuth discovery', async () => {
        const reply = await harness.post(harness.request('tools/list'), 'invalid');
        expect(reply.response.status).toBe(401);
        expect(reply.response.headers.get('www-authenticate')).toBe(
            'Bearer resource_metadata="https://api.example.test/mcp"',
        );
        expect(translators.calls).toBe(0);
    });

    it('an unknown tool is still a JSON-RPC protocol error, not an app-owned result', async () => {
        const payload = await harness.callTool('no_such_tool', {});
        expect(payload.error?.code).toBe(-32_602);
        expect(translators.calls).toBe(0);
    });
});

describe('no application translator registered', () => {
    let bridge: WpMcpServer<string, string>;
    let httpServer: Server;
    let harness: McpHttpTestHarness;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        const jwtHook = new TestJwtHook();
        const module = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        const router = await WebpiecesRouterFactory.create({ appBindings: [module] });
        router.addRoutes(LockApi, LockController);
        bridge = new WpMcpServer(
            new WpMcpServerConfig<string, string>()
                .setName('plain-server')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/mcp')
                .setAccessTokenAuthority(new TestTokenAuthority())
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
                [McpApiBinding.local(LockApi, router)],
                McpDeployment.singleProcess(),
            ),
        );
        httpServer = await TestServers.listen(app);
        harness = new McpHttpTestHarness(TestServers.urlOf(httpServer), ENDPOINT_PATH);
    });

    afterAll(async () => {
        await bridge.close();
        await TestServers.close(httpServer);
    });

    it('renders the webpieces default with its requestId _meta', async () => {
        const payload = await harness.callTool('passage_open', { passageId: 'locked' });
        const result = harness.resultOf(payload);
        expect(result['isError']).toBe(true);
        expect(result['structuredContent']).toBeUndefined();
        const visible = harness.modelErrorOf(payload);
        expect(visible['kind']).toBe('implementation');
        const meta = result['_meta'] as Record<string, unknown>;
        expect(typeof meta['webpieces/requestId']).toBe('string');
    });
});
