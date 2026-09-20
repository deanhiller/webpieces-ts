import { expect } from 'vitest';
import { McpPostReply, RpcResponse } from './McpHttpTestHarness';

/**
 * Speaks the 2025-era MCP wire (the `initialize` handshake, no per-request `_meta` envelope) to one
 * bound endpoint, the way every shipping MCP client still does. Kept separate from
 * `McpHttpTestHarness` on purpose: the two eras are different wires, and a harness that could emit
 * either would hide which one a spec is actually proving.
 */
export class LegacyMcpHttpTestHarness {
    private nextId = 0;

    constructor(
        public readonly baseUrl: string,
        private readonly endpointPath: string,
    ) {}

    /** A legacy JSON-RPC request: having NO `_meta` envelope claim is what classifies it legacy. */
    request(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
        return { jsonrpc: '2.0', id: ++this.nextId, method, params };
    }

    initialize(protocolVersion: string): Record<string, unknown> {
        return this.request('initialize', {
            protocolVersion,
            clientInfo: { name: 'webpieces-legacy-spec', version: '1.0.0' },
            capabilities: {},
        });
    }

    /**
     * `token` null sends no Authorization header. No `mcp-protocol-version` header by default: a
     * 2025 client only sends one after the handshake, and `negotiatedVersion` is how it does.
     */
    async post(
        body: Record<string, unknown>,
        token: string | null = 'mcp-user',
        negotiatedVersion?: string,
    ): Promise<McpPostReply> {
        const headers: Record<string, string> = {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
        };
        if (token !== null) headers['authorization'] = `Bearer ${token}`;
        if (negotiatedVersion !== undefined) headers['mcp-protocol-version'] = negotiatedVersion;
        const response = await fetch(`${this.baseUrl}${this.endpointPath}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        return new McpPostReply(response, await this.payloadOf(response));
    }

    resultOf(payload: RpcResponse): Record<string, unknown> {
        expect(payload.error).toBeUndefined();
        if (!payload.result) throw new Error('legacy MCP response has no result');
        return payload.result;
    }

    /** The 2025 leg may answer either JSON or a one-event SSE stream; both carry one JSON-RPC body. */
    private async payloadOf(response: Response): Promise<RpcResponse> {
        const text = await response.text();
        if (text.startsWith('{')) return JSON.parse(text) as RpcResponse;
        const line = text.split('\n').find((candidate: string) => candidate.startsWith('data: '));
        if (!line) return {};
        return JSON.parse(line.slice('data: '.length)) as RpcResponse;
    }
}
