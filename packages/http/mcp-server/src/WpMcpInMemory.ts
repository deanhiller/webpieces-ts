import { Client } from '@modelcontextprotocol/client';
import {
    InMemoryTransport,
    JSONRPCMessage,
    Transport,
    TransportSendOptions,
} from '@modelcontextprotocol/server';
import { ApiImplementationError } from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { McpToolRequest, McpToolset } from './McpToolset';
import { RegisteredMcpTool } from './McpToolRegistry';

/** In-memory MCP has no socket to lose, so its disconnect signal never fires; cancellation is the SDK's. */
const NEVER_DISCONNECTED = new AbortController().signal;

/**
 * One end of the SDK's linked in-memory pair, sending each message as the WIRE would: a JSON copy.
 * The SDK pair hands the receiver the sender's object itself, so a class-typed schema or a caller's
 * DTO instance would reach the other side by reference and fail the SDK's plain-JSON validation (or
 * be mutated across the boundary). The copy is made synchronously inside `send`, so the receiver
 * still runs in the SENDER's async context — which is what lets the toolset read the caller per request.
 */
class McpWireCopyTransport implements Transport {
    constructor(private readonly inner: InMemoryTransport) {}

    get onmessage(): Transport['onmessage'] {
        return this.inner.onmessage;
    }

    set onmessage(handler: Transport['onmessage']) {
        this.inner.onmessage = handler;
    }

    get onclose(): Transport['onclose'] {
        return this.inner.onclose;
    }

    set onclose(handler: Transport['onclose']) {
        this.inner.onclose = handler;
    }

    get onerror(): Transport['onerror'] {
        return this.inner.onerror;
    }

    set onerror(handler: Transport['onerror']) {
        this.inner.onerror = handler;
    }

    start(): Promise<void> {
        return this.inner.start();
    }

    close(): Promise<void> {
        return this.inner.close();
    }

    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        return this.inner.send(JSON.parse(JSON.stringify(message)) as JSONRPCMessage, options);
    }
}

/**
 * The in-memory transport over an {@link McpToolset}: an official MCP SDK `Client` wired to the
 * toolset's server through the SDK's linked `InMemoryTransport` pair, for an agent that runs its model
 * loop in-process and already holds a verified caller in its `RequestContext`.
 *
 * ```ts
 * const client: Client = await WpMcpInMemory.connect(toolset);   // once per process
 * // ...inside a request whose caller AuthFilter already verified:
 * const { tools } = await client.listTools();                    // only what THIS caller may see
 * await client.callTool({ name: 'stores_pause', arguments: { storeId } });
 * ```
 *
 * NO CREDENTIAL. The caller is whoever is trusted in the `RequestContext` of the code calling
 * `client.listTools()` / `client.callTool()`, READ PER REQUEST and NEVER captured at connect. Apps cache
 * one client per process, so a connect-time capture would run user B's call as user A. The SDK's
 * in-memory transport delivers each message synchronously inside the caller's own `send`, so the
 * toolset's handlers run in the caller's async context; a call made outside any `RequestContext` is
 * refused rather than run as nobody.
 *
 * The caller's scope is the one the tool runs in: a local binding's `InvocationAuthentication` needs
 * that scope to have completed verified ingress (it did, if an endpoint's `AuthFilter` admitted the
 * request). That is also why `McpToolset` refuses a SERVICE_ONLY tool: the caller's own service hop
 * would satisfy it for every model behind it. No tools/list cache hint is sent, so one shared client
 * never serves user A's list to user B.
 */
export class WpMcpInMemory {
    // webpieces-disable no-function-outside-class -- explicit public factory of a connected SDK client
    static async connect(toolset: McpToolset): Promise<Client> {
        const pair = InMemoryTransport.createLinkedPair();
        const server = toolset.createSdkServer(
            { name: 'webpieces-mcp-toolset', version: toolset.revision },
            { capabilities: { tools: { listChanged: true } } },
            async (): Promise<McpToolRequest> => {
                if (!RequestContext.isActive()) {
                    throw new ApiImplementationError(
                        'WpMcpInMemory client calls must run inside the RequestContext of a verified caller; ' +
                            'the in-memory transport reads the caller from it on every request.',
                    );
                }
                return new McpToolRequest(await toolset.authorizedTools(), NEVER_DISCONNECTED);
            },
            (name: string): RegisteredMcpTool | undefined => toolset.registry.find(name),
        );
        await server.connect(new McpWireCopyTransport(pair[1]));
        const client = new Client({
            name: 'webpieces-in-memory-client',
            version: toolset.revision,
        });
        await client.connect(new McpWireCopyTransport(pair[0]));
        return client;
    }
}
