import 'reflect-metadata';
import { Server } from 'node:http';
import express, { Express, Request, Response } from 'express';
import {
    createMcpHandler,
    ListToolsResult,
    McpHttpHandler,
    McpRequestContext,
    McpServer,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpDeployment } from './McpDeployment';
import { McpHttpTestHarness, TestServers } from './__tests__/McpHttpTestHarness';
import { ENDPOINT_PATH } from './__tests__/WpMcpServerTestFixtures';

/**
 * ISSUE #961's open task: what does the OFFICIAL MCP SDK do with a NON-`ProtocolError` throw from a
 * request handler?
 *
 * It matters because it decides what `WpMcpErrorTranslator.toListError` IS. If the SDK already
 * renders a safe `-32603` with generic text, `toListError` is defence in depth and a nicer message.
 * If the SDK puts the throw's own `message` on the wire, `toListError` is LOAD-BEARING for
 * disclosure and must never be bypassed — and this spec is the thing that tells us which, on every
 * SDK upgrade, instead of anybody guessing.
 *
 * So this deliberately bypasses `WpMcpServer` and drives the SDK directly: one `createMcpHandler`
 * whose `tools/list` handler throws a plain `Error` carrying a distinctive secret.
 */
describe('the official MCP SDK, handed a foreign (non-ProtocolError) throw', () => {
    const SECRET = 'SECRET-sdk-foreign-throw-detail';
    let httpServer: Server;
    let harness: McpHttpTestHarness;
    let handler: McpHttpHandler;

    beforeAll(async () => {
        handler = createMcpHandler(
            (_context: McpRequestContext) => {
                const server = new McpServer(
                    { name: 'foreign-throw-probe', version: '1.0.0' },
                    { capabilities: { tools: { listChanged: true } } },
                );
                server.server.removeRequestHandler('tools/list');
                server.server.setRequestHandler('tools/list', (): Promise<ListToolsResult> => {
                    throw new Error(SECRET);
                });
                return server;
            },
            {
                legacy: 'reject',
                responseMode: 'auto',
                bus: McpDeployment.singleProcess().bus,
                onerror: (): void => {
                    // The probe asserts on the WIRE, not on the SDK's own error channel.
                },
            },
        );
        const node = toNodeHandler(handler, {
            onerror: (): void => {
                // same
            },
        });
        const app: Express = express();
        app.post(
            ENDPOINT_PATH,
            express.json(),
            async (req: Request, res: Response): Promise<void> => {
                await node(req, res, req.body);
            },
        );
        httpServer = await TestServers.listen(app);
        harness = new McpHttpTestHarness(TestServers.urlOf(httpServer), ENDPOINT_PATH);
    });

    afterAll(async () => {
        await handler.close();
        await TestServers.close(httpServer);
    });

    /**
     * THE ANSWER, measured on `@modelcontextprotocol/server` 2.0.0: the SDK wraps a foreign throw in
     * `-32603` but copies its `message` ONTO THE WIRE, verbatim.
     *
     * So `WpMcpErrorTranslator.toListError` is LOAD-BEARING for disclosure, not defence in depth. A
     * `tools/list` handler that lets any error escape un-translated publishes that error's operator
     * text to the caller — the exact leak `ApiErrorBoundary.encode` exists to prevent. That is why
     * `WpMcpServer.handleListTools` catches EVERYTHING and why `toListError` is typed `never`: the
     * compiler knows the call is terminal, so there is no path back out of the catch that forgets to
     * throw a `ProtocolError`.
     *
     * Pinned in both directions. If a future SDK starts genericising the message, THIS test goes red
     * and somebody re-reads the paragraph above instead of inheriting a stale assumption.
     */
    it('wraps a foreign throw in -32603 but LEAKS its message verbatim', async () => {
        const reply = await harness.post(harness.request('tools/list'), null);

        expect(reply.payload.error?.code).toBe(-32_603);
        expect(reply.payload.error?.message).toBe(SECRET);
    });
});
