import 'reflect-metadata';
import { Server } from 'node:http';
import { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/client';
import express, { NextFunction, Request, Response } from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    HeaderRegistry,
    Mcp,
    McpToolOperation,
    oidcSameProject,
    READ,
    UNKNOWN_OPERATION,
    WebpiecesCoreHeaders,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { JWT_HOOK, OIDC_HOOK, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import {
    McpApprovalDecision,
    McpApprovalHooks,
    McpApprovalRequired,
    McpRemoteToolCall,
} from './McpApproval';
import { WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpToolset } from './McpToolset';
import { WpMcpClient } from './WpMcpClient';
import { McpIdTokenMinter, WpMcpRemote, WpMcpRemoteOptions } from './WpMcpRemote';
import { WpMcpServer } from './WpMcpServer';
import { TestServers } from './__tests__/McpHttpTestHarness';
import {
    AskedApproval,
    HOST_APPROVED_TOOL,
    NOTES_CATALOG,
    NotesApi,
    NotesController,
    ScriptedApprovalHook,
} from './__tests__/McpApprovalFixtures';
import {
    DevOidcTokens,
    ProjectOidcHook,
    SAME_PROJECT_SA,
    TransportJwtHook,
    VerifiedCaller,
} from './__tests__/McpTransportFixtures';

class DevMinter implements McpIdTokenMinter {
    async mintIdToken(audience: string): Promise<string> {
        return DevOidcTokens.of(SAME_PROJECT_SA, audience);
    }
}

/**
 * The host-side approval hook on WpMcpRemote (#1422), against a real WpMcpServer serving one READ, one
 * WRITE and one WRITE_IDEMPOTENT tool over loopback HTTP. What LEFT the client is read off the server:
 * every JSON-RPC method it received, and every controller call.
 */
describe('WpMcpRemote approval hook, end to end', () => {
    let http: Server;
    let callee: WpMcpServer;
    let url: string;
    const received: string[] = [];
    const alice = new VerifiedCaller('alice', []);
    const open: WpMcpClient[] = [];

    async function connect(options: WpMcpRemoteOptions): Promise<WpMcpClient> {
        const client = await WpMcpRemote.connect(url, oidcSameProject(), new DevMinter(), options);
        open.push(client);
        received.length = 0;
        return client;
    }

    async function connectWith(hook: ScriptedApprovalHook): Promise<WpMcpClient> {
        return connect(new WpMcpRemoteOptions(hook));
    }

    function call(client: WpMcpClient, name: string): Promise<CallToolResult> {
        return alice.run(() => client.callTool({ name, arguments: { query: `q-${name}` } }));
    }

    beforeAll(async () => {
        HeaderRegistry.configure(WebpiecesCoreHeaders.ALL_HEADERS, true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TransportJwtHook());
                    options.bind(OIDC_HOOK).toConstantValue(new ProjectOidcHook());
                }),
            ],
        });
        router.addRoutes(NotesApi, NotesController);
        callee = new WpMcpServer(
            new WpMcpServerConfig()
                .setName('notes')
                .setTitle('Notes')
                .setDescription('The callee of an approval-gated MCP hop.')
                .setWebsiteUrl('https://docs.example.test/mcp')
                .setVersion('1.0.0')
                .setResource('https://notes.example.test/mcp')
                .setAuth([oidcSameProject()])
                .setCredentialVerifiers(router.credentialVerifiers()),
            new McpToolset(
                [McpApiBinding.local(NotesApi, router)],
                [NOTES_CATALOG],
                router.authorizationService(),
                [Mcp.DEFAULT],
            ),
        );
        const app = express();
        app.use(express.json());
        app.use((req: Request, _res: Response, next: NextFunction): void => {
            const method = (req.body as { method?: string } | undefined)?.method;
            if (method !== undefined && !method.startsWith('notifications/')) received.push(method);
            next();
        });
        callee.bind(app, new McpBindOptions('/mcp', McpDeployment.singleProcess()));
        http = await TestServers.listen(app);
        url = `${TestServers.urlOf(http)}/mcp`;
    });

    beforeEach(() => {
        NotesController.calls.length = 0;
    });

    afterAll(async () => {
        for (const client of open) await client.close();
        await callee.close();
        await TestServers.close(http);
    });

    it('ALLOW_ALL sends exactly the one tools/call an unhooked client sent, and no tools/list', async () => {
        const client = await connect(new WpMcpRemoteOptions(McpApprovalHooks.ALLOW_ALL));

        const result = await call(client, 'notes_add');

        expect(received).toEqual(['tools/call']);
        expect(result.structuredContent).toEqual({ userId: 'alice', result: 'q-notes_add' });
        expect(NotesController.calls).toEqual(['add']);
    });

    it('asks the hook on every call, with the operation, arguments and url, inside the caller context', async () => {
        const hook = new ScriptedApprovalHook();
        const client = await connectWith(hook);

        await alice.run(async () => {
            RequestContext.putUntrusted(HOST_APPROVED_TOOL, 'notes_put');
            await client.callTool({ name: 'notes_put', arguments: { query: 'one' } });
            await client.callTool({ name: 'notes_list', arguments: { query: 'two' } });
            await client.callTool({ name: 'notes_add', arguments: { query: 'three' } });
        });

        expect(hook.asked.map((asked: AskedApproval): string | undefined => asked.approvedTool)).toEqual([
            'notes_put',
            'notes_put',
            'notes_put',
        ]);
        expect(
            hook.asked.map((asked: AskedApproval): McpToolOperation => asked.call.tool.operation),
        ).toEqual([WRITE_IDEMPOTENT, READ, WRITE]);
        const first = hook.asked[0]!.call;
        expect(first.args).toEqual({ query: 'one' });
        expect(first.remoteUrl).toBe(url);
        expect(first.tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
        expect(first.tool.title).toBe('Notes notes_put');
        expect(first.tool.inputSchema).toBeDefined();
        // The first unseen name triggered ONE tools/list; the next two names were already known.
        expect(received).toEqual(['tools/list', 'tools/call', 'tools/call', 'tools/call']);
        expect(NotesController.calls).toEqual(['put', 'list', 'add']);
    });

    it('knows every tool a listTools already returned, without listing again', async () => {
        const hook = new ScriptedApprovalHook();
        const client = await connectWith(hook);

        await alice.run(() => client.listTools());
        await call(client, 'notes_add');

        expect(received).toEqual(['tools/list', 'tools/call']);
        expect(hook.asked[0]!.call.tool.operation).toBe(WRITE);
    });

    it('REQUIRE_APPROVAL sends nothing and answers a waiting result the host can recognise', async () => {
        const hook = new ScriptedApprovalHook();
        hook.decide = (asked: McpRemoteToolCall): McpApprovalDecision =>
            asked.tool.operation === READ
                ? McpApprovalDecision.allow()
                : McpApprovalDecision.requireApproval('Add a note to order 7');
        const client = await connectWith(hook);
        await alice.run(() => client.listTools());
        received.length = 0;

        const waiting = await call(client, 'notes_add');

        expect(received).toEqual([]);
        expect(NotesController.calls).toEqual([]);
        expect(waiting.isError).toBeUndefined();
        expect(waiting.content).toEqual([
            { type: 'text', text: 'Waiting for approval: Add a note to order 7' },
        ]);
        expect(waiting._meta).toEqual({ 'webpieces/approvalRequired': true });
        expect(JSON.parse(JSON.stringify(waiting.structuredContent))).toEqual({
            status: 'approval_required',
            tool: 'notes_add',
            args: { query: 'q-notes_add' },
            summary: 'Add a note to order 7',
        });
        const pending = McpApprovalRequired.from(waiting)!;
        expect([pending.tool, pending.args, pending.summary]).toEqual([
            'notes_add',
            { query: 'q-notes_add' },
            'Add a note to order 7',
        ]);
        // Recognised after a JSON round trip too, the way a host may have stored it.
        const roundTripped = JSON.parse(JSON.stringify(waiting)) as CallToolResult;
        expect(McpApprovalRequired.from(roundTripped)?.tool).toBe('notes_add');

        const read = await call(client, 'notes_list');
        expect(McpApprovalRequired.from(read)).toBeUndefined();
        expect(received).toEqual(['tools/call']);
    });

    it('names the tool in the waiting text when the hook gave no summary', async () => {
        const hook = new ScriptedApprovalHook();
        hook.decide = (): McpApprovalDecision => McpApprovalDecision.requireApproval();
        const client = await connectWith(hook);

        const waiting = await call(client, 'notes_put');

        expect(waiting.content).toEqual([{ type: 'text', text: 'Waiting for approval: notes_put' }]);
        expect(McpApprovalRequired.from(waiting)?.summary).toBeUndefined();
    });

    it('DENY sends nothing and answers a tool error carrying the reason', async () => {
        const hook = new ScriptedApprovalHook();
        hook.decide = (): McpApprovalDecision =>
            McpApprovalDecision.deny('Writes are disabled in this chat.', 'Put a note');
        const client = await connectWith(hook);
        await alice.run(() => client.listTools());
        received.length = 0;

        const denied = await call(client, 'notes_put');

        expect(received).toEqual([]);
        expect(NotesController.calls).toEqual([]);
        expect(denied.isError).toBe(true);
        expect(denied.content).toEqual([{ type: 'text', text: 'Writes are disabled in this chat.' }]);
        expect(JSON.parse(JSON.stringify(denied.structuredContent))).toEqual({
            status: 'denied',
            tool: 'notes_put',
            reason: 'Writes are disabled in this chat.',
            summary: 'Put a note',
        });
        expect(McpApprovalRequired.from(denied)).toBeUndefined();
    });

    it('a hook that throws sends nothing and propagates the error', async () => {
        const hook = new ScriptedApprovalHook();
        hook.decide = (): McpApprovalDecision => {
            throw new Error('approval store unreachable');
        };
        const client = await connectWith(hook);
        await alice.run(() => client.listTools());
        received.length = 0;

        await expect(call(client, 'notes_add')).rejects.toThrow('approval store unreachable');

        expect(received).toEqual([]);
        expect(NotesController.calls).toEqual([]);
    });

    it('a name the server does not list reaches the hook as UNKNOWN after one tools/list', async () => {
        const hook = new ScriptedApprovalHook();
        hook.decide = (): McpApprovalDecision => McpApprovalDecision.deny('unknown tool');
        const client = await connectWith(hook);

        const denied = await call(client, 'notes_delete_everything');

        expect(received).toEqual(['tools/list']);
        expect(denied.isError).toBe(true);
        const tool = hook.asked[0]!.call.tool;
        expect([tool.name, tool.operation, tool.annotations, tool.inputSchema]).toEqual([
            'notes_delete_everything',
            UNKNOWN_OPERATION,
            {},
            undefined,
        ]);
    });

    it('publishes an additive WRITE as not destructive, and a WRITE_IDEMPOTENT as destructive', async () => {
        const client = await connect(new WpMcpRemoteOptions(McpApprovalHooks.ALLOW_ALL));

        const listed = await alice.run(() => client.listTools());
        const byName = new Map<string, ToolAnnotations | undefined>(
            listed.tools.map((tool: Tool): [string, ToolAnnotations | undefined] => [
                tool.name,
                tool.annotations,
            ]),
        );

        expect(byName.get('notes_add')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
        expect(byName.get('notes_put')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect(byName.get('notes_list')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });
});
