import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
    DestinationTrust,
    HeaderRegistry,
    MCP_INVOCATION_CONTEXT,
    McpInvocationContext,
    oidcSameProject,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';

// Drive the actual inbound/outbound context boundary: the moved metadata remains process-local.
describe('shared MCP invocation metadata at HTTP boundaries', () => {
    it('refuses caller headers as invocation facts and never forwards verified invocation metadata', async () => {
        HeaderRegistry.configure([MCP_INVOCATION_CONTEXT], true);
        const headers = new RequestContextHeaders();
        const controller = new AbortController();
        const invocation = new McpInvocationContext(
            42,
            'search',
            'verified-user',
            ['reader'],
            controller.signal,
        );
        await RequestContext.run(async () => {
            headers.fillFromRequest(
                new HttpRequest(
                    'POST',
                    '/mcp',
                    new Map([
                        ['mcpinvocationcontext', ['forged']],
                        ['x-mcp-invocation-context', ['forged']],
                    ]),
                ),
            );
            expect(RequestContext.getTrusted(MCP_INVOCATION_CONTEXT)).toBeUndefined();
            RequestContext.putTrusted(MCP_INVOCATION_CONTEXT, invocation);
            expect(RequestContext.getTrusted(MCP_INVOCATION_CONTEXT)).toBe(invocation);
            const outbound = headers.buildOutboundHeaders(
                DestinationTrust.forAuthMode(oidcSameProject()),
            );
            expect([...outbound.values()].join(' ')).not.toContain('verified-user');
            expect(outbound.has('mcpinvocationcontext')).toBe(false);
            expect(outbound.has('x-mcp-invocation-context')).toBe(false);
            const response = headers.buildResponseHeaders();
            expect([...response.values()].join(' ')).not.toContain('verified-user');
            expect(response.has('mcpinvocationcontext')).toBe(false);
            expect(response.has('x-mcp-invocation-context')).toBe(false);
        });
        await RequestContext.run(async () => {
            expect(RequestContext.getTrusted(MCP_INVOCATION_CONTEXT)).toBeUndefined();
        });
    });
});
