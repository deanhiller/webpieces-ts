import { CallToolResult, Client, ListToolsResult, Tool } from '@modelcontextprotocol/client';

/** The `tools/call` parameters, exactly as `Client.callTool` takes them. */
export type McpClientSetCall = Parameters<Client['callTool']>[0];

/** Two connected clients publish one tool name: tool names are flat across servers, so it is refused. */
export class McpDuplicateToolError extends Error {
    constructor(
        public readonly toolName: string,
        public readonly firstClient: number,
        public readonly secondClient: number,
    ) {
        super(
            `MCP tool '${toolName}' is published by client #${firstClient} and client #${secondClient}. ` +
                'Tool names are flat across every server an agent holds, so the call could not be routed; ' +
                'rename one tool or drop one client.',
        );
        this.name = 'McpDuplicateToolError';
    }
}

/** A tool name no merged client publishes to the current caller. */
export class McpUnknownToolError extends Error {
    constructor(public readonly toolName: string) {
        super(`Unknown MCP tool '${toolName}': no merged client publishes it to this caller.`);
        this.name = 'McpUnknownToolError';
    }
}

/**
 * Several MCP clients an agent holds — its in-memory toolset plus another service's remote endpoint —
 * presented as one: `listTools()` is the union, `callTool()` routes by name.
 *
 * Tool names are flat across servers, so a name published by two clients is REFUSED with
 * {@link McpDuplicateToolError}: at {@link merge} (connect time) and again on every `listTools()`,
 * because each server projects its tools per caller and a later caller can see a tool an earlier one
 * could not. Like the clients it merges, it reads the caller per request: call it inside the
 * `RequestContext` of the caller.
 */
export class McpClientSet {
    private routes = new Map<string, Client>();

    private constructor(private readonly clients: readonly Client[]) {}

    // webpieces-disable no-function-outside-class -- validating factory; refuses duplicate names before the set exists
    static async merge(clients: readonly Client[]): Promise<McpClientSet> {
        if (clients.length === 0)
            throw new Error('McpClientSet.merge(...) requires at least one client.');
        const set = new McpClientSet([...clients]);
        await set.listTools();
        return set;
    }

    /** The union of every client's tools for the current caller; refuses a name two clients publish. */
    async listTools(): Promise<Tool[]> {
        const lists = await Promise.all(this.clients.map((client: Client) => client.listTools()));
        const routes = new Map<string, Client>();
        const owners = new Map<string, number>();
        const tools: Tool[] = [];
        lists.forEach((list: ListToolsResult, index: number) => {
            for (const tool of list.tools) {
                const owner = owners.get(tool.name);
                if (owner !== undefined) throw new McpDuplicateToolError(tool.name, owner, index);
                owners.set(tool.name, index);
                routes.set(tool.name, this.clients[index]);
                tools.push(tool);
            }
        });
        this.routes = routes;
        return tools;
    }

    /** Routes the call to the client that publishes `params.name`, refreshing the routes once if unknown. */
    async callTool(params: McpClientSetCall): Promise<CallToolResult> {
        let client = this.routes.get(params.name);
        if (client === undefined) {
            await this.listTools();
            client = this.routes.get(params.name);
        }
        if (client === undefined) throw new McpUnknownToolError(params.name);
        return client.callTool(params);
    }
}
