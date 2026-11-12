import {
    CacheableRequestOptions,
    CallToolRequestOptions,
    CallToolResult,
    Client,
    ClientOptions,
    Implementation,
    ListToolsResult,
    Tool,
} from '@modelcontextprotocol/client';
import {
    McpApprovalDecisionKind,
    McpApprovalDenied,
    McpApprovalHook,
    McpApprovalHooks,
    McpApprovalRequired,
    McpRemoteToolCall,
    McpRemoteToolInfo,
} from './McpApproval';

/** The `tools/call` parameters, exactly as `Client.callTool` takes them. */
type CallToolParams = Parameters<Client['callTool']>[0];
/** The `tools/list` parameters, exactly as `Client.listTools` takes them. */
type ListToolsParams = Parameters<Client['listTools']>[0];

/**
 * The MCP SDK `Client` `WpMcpRemote.connect` returns: identical to it except that `callTool` goes
 * through the host's {@link McpApprovalHook} first (#1422). Every other method is the SDK's own, and
 * every existing `Client` call site keeps compiling.
 *
 * `callTool(params)`:
 * 1. looks up the tool's metadata by name — from a per-client map every `listTools` fills, or, on a
 *    miss, from ONE `listTools` refresh (which follows pagination); a name still missing reaches the
 *    hook as `UNKNOWN_OPERATION` with empty annotations;
 * 2. awaits `approvalHook.check(call)` — on EVERY call, inside the caller's `RequestContext`;
 * 3. ALLOW sends it exactly as the SDK would; REQUIRE_APPROVAL and DENY send NOTHING and answer a
 *    result ({@link McpApprovalRequired.result} / {@link McpApprovalDenied.result}); a hook that throws
 *    sends nothing and propagates.
 *
 * The map holds only annotations, which do not vary by caller; whether a caller SEES a tool does, and
 * the server still decides that on every call. Nothing about approval is stored here.
 *
 * `McpApprovalHooks.ALLOW_ALL` skips step 1 entirely, so a host that chose it sends exactly the bytes
 * it sent before the hook existed.
 */
export class WpMcpClient extends Client {
    private readonly tools = new Map<string, McpRemoteToolInfo>();

    constructor(
        clientInfo: Implementation,
        options: ClientOptions,
        private readonly approvalHook: McpApprovalHook,
        private readonly remoteUrl: string,
    ) {
        super(clientInfo, options);
    }

    override async listTools(
        params?: ListToolsParams,
        options?: CacheableRequestOptions,
    ): Promise<ListToolsResult> {
        const result = await super.listTools(params, options);
        for (const tool of result.tools) this.record(tool);
        return result;
    }

    override async callTool(
        params: CallToolParams,
        options?: CallToolRequestOptions,
    ): Promise<CallToolResult> {
        if (this.approvalHook === McpApprovalHooks.ALLOW_ALL) return super.callTool(params, options);
        const args = params.arguments ?? {};
        const call = new McpRemoteToolCall(await this.toolInfo(params.name), args, this.remoteUrl);
        const decision = await this.approvalHook.check(call);
        switch (decision.kind) {
            case McpApprovalDecisionKind.ALLOW:
                return super.callTool(params, options);
            case McpApprovalDecisionKind.REQUIRE_APPROVAL:
                return McpApprovalRequired.result(params.name, args, decision.summary);
            case McpApprovalDecisionKind.DENY:
                return McpApprovalDenied.result(params.name, decision.reason!, decision.summary);
        }
    }

    private record(tool: Tool): void {
        this.tools.set(tool.name, McpRemoteToolInfo.fromTool(tool));
    }

    private async toolInfo(name: string): Promise<McpRemoteToolInfo> {
        const known = this.tools.get(name);
        if (known !== undefined) return known;
        await this.listTools();
        return this.tools.get(name) ?? McpRemoteToolInfo.unknown(name);
    }
}
