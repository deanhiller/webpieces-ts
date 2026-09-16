import { createServer, Server } from 'node:http';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { Express } from 'express';
import { expect } from 'vitest';
import { MODERN_VERSION } from './WpMcpServerTestFixtures';

export interface RpcResponse {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: Record<string, unknown> };
}

export class McpPostReply {
    constructor(
        public readonly response: Response,
        public readonly payload: RpcResponse,
    ) {}
}

/** Starts and stops loopback HTTP servers for MCP specs. */
export class TestServers {
    static async listen(app: Express): Promise<Server> {
        const server = createServer(app);
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        return server;
    }

    static urlOf(server: Server): string {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('test server has no port');
        return `http://127.0.0.1:${address.port}`;
    }

    static async close(server: Server): Promise<void> {
        await new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
            server.close((error?: Error) => (error ? reject(error) : resolve()));
        });
    }
}

/** Speaks MCP 2026-07-28 Streamable HTTP to one bound endpoint, the way a real client would. */
export class McpHttpTestHarness {
    private nextId = 0;

    constructor(
        public readonly baseUrl: string,
        private readonly endpointPath: string,
    ) {}

    request(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            jsonrpc: '2.0',
            id: ++this.nextId,
            method,
            params: {
                ...params,
                _meta: {
                    [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
                    [CLIENT_INFO_META_KEY]: { name: 'webpieces-spec', version: '1.0.0' },
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                },
            },
        };
    }

    /** `token` null sends no Authorization header; a string `body` is sent verbatim. */
    async post(
        body: Record<string, unknown> | string,
        token: string | null = 'mcp-user',
        extraHeaders: Record<string, string> = {},
        path = this.endpointPath,
    ): Promise<McpPostReply> {
        const fields = typeof body === 'string' ? {} : body;
        const headers: Record<string, string> = {
            accept: 'application/json',
            'content-type': 'application/json',
            'mcp-protocol-version': MODERN_VERSION,
            'mcp-method': typeof fields['method'] === 'string' ? fields['method'] : 'unknown',
            ...extraHeaders,
        };
        if (token !== null) headers['authorization'] = `Bearer ${token}`;
        this.mirrorToolHeaders(fields['params'], headers);
        const response = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        const text = await response.text();
        const payload = text.startsWith('{') ? (JSON.parse(text) as RpcResponse) : {};
        return new McpPostReply(response, payload);
    }

    /** Opens a `subscriptions/listen` response stream and returns its reader. */
    async openListen(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
        const body = this.request('subscriptions/listen', {
            notifications: { toolsListChanged: true },
        });
        const response = await fetch(`${this.baseUrl}${this.endpointPath}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer mcp-user',
                accept: 'text/event-stream',
                'content-type': 'application/json',
                'mcp-protocol-version': MODERN_VERSION,
                'mcp-method': 'subscriptions/listen',
            },
            body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('subscription response has no body');
        return reader;
    }

    async readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
        const chunk = await reader.read();
        return chunk.done ? '' : new TextDecoder().decode(chunk.value);
    }

    async toolNames(): Promise<string[]> {
        const reply = await this.post(this.request('tools/list'));
        const tools = this.resultOf(reply.payload)['tools'] as Array<Record<string, unknown>>;
        return tools.map((tool: Record<string, unknown>) => String(tool['name']));
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        token = 'mcp-user',
    ): Promise<RpcResponse> {
        return (await this.post(this.request('tools/call', { name, arguments: args }), token))
            .payload;
    }

    resultOf(payload: RpcResponse): Record<string, unknown> {
        expect(payload.error).toBeUndefined();
        if (!payload.result) throw new Error('MCP response has no result');
        return payload.result;
    }

    structuredOf(payload: RpcResponse): Record<string, unknown> {
        const value = this.resultOf(payload)['structuredContent'];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`missing structuredContent: ${JSON.stringify(payload)}`);
        }
        return value as Record<string, unknown>;
    }

    modelErrorOf(payload: RpcResponse): Record<string, unknown> {
        const result = this.resultOf(payload);
        const content = result['content'];
        expect(result['isError']).toBe(true);
        if (!Array.isArray(content) || typeof content[0]?.text !== 'string')
            throw new Error('missing error content');
        return JSON.parse(content[0].text) as Record<string, unknown>;
    }

    private mirrorToolHeaders(params: unknown, headers: Record<string, string>): void {
        if (!params || typeof params !== 'object' || Array.isArray(params)) return;
        const name = (params as Record<string, unknown>)['name'];
        if (typeof name === 'string' && headers['mcp-name'] === undefined)
            headers['mcp-name'] = name;
        const args = (params as Record<string, unknown>)['arguments'];
        if (!args || typeof args !== 'object' || Array.isArray(args)) return;
        const query = (args as Record<string, unknown>)['query'];
        if (typeof query === 'string' && headers['mcp-param-query'] === undefined) {
            headers['mcp-param-query'] = query;
        }
    }
}
