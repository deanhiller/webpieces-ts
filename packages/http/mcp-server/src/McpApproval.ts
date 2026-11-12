import { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/client';
import { McpToolOperation, operationForMcpHints, UNKNOWN_OPERATION } from '@webpieces/core-util';

/**
 * The `_meta` key that marks a `tools/call` result {@link WpMcpClient} produced INSTEAD of sending the
 * call, because the host's {@link McpApprovalHook} answered REQUIRE_APPROVAL.
 * {@link McpApprovalRequired.from} reads it.
 */
export const MCP_APPROVAL_REQUIRED_META_KEY = 'webpieces/approvalRequired';

/** Nominal backing for {@link McpApprovalDecision.kind}. */
export enum McpApprovalDecisionKind {
    /** Send the call, exactly as an unhooked client would. */
    ALLOW = 'ALLOW',
    /** Send nothing; answer the model "waiting for approval". */
    REQUIRE_APPROVAL = 'REQUIRE_APPROVAL',
    /** Send nothing; answer the model an error carrying the reason. */
    DENY = 'DENY',
}

/**
 * What an {@link McpApprovalHook} answers for one call. Built only through the three factories, so a
 * DENY always carries its reason and an ALLOW carries nothing — one spelling per decision.
 */
export class McpApprovalDecision {
    private static readonly ALLOWED = new McpApprovalDecision(
        McpApprovalDecisionKind.ALLOW,
        undefined,
        undefined,
    );

    private constructor(
        public readonly kind: McpApprovalDecisionKind,
        /** Why a DENY was refused; shown to the model as the error text. Undefined otherwise. */
        public readonly reason: string | undefined,
        /** A short human description of the call, for the model's text and the host's card. */
        public readonly summary: string | undefined,
    ) {}

    /** Send the call. */
    // webpieces-disable no-function-outside-class -- named factory of the decision value
    static allow(): McpApprovalDecision {
        return McpApprovalDecision.ALLOWED;
    }

    /** Send nothing, and tell the model the call is waiting for a person's approval. */
    // webpieces-disable no-function-outside-class -- named factory of the decision value
    static requireApproval(summary?: string): McpApprovalDecision {
        return new McpApprovalDecision(McpApprovalDecisionKind.REQUIRE_APPROVAL, undefined, summary);
    }

    /** Send nothing, and tell the model the call was refused, and why. */
    // webpieces-disable no-function-outside-class -- named factory of the decision value
    static deny(reason: string, summary?: string): McpApprovalDecision {
        if (reason.trim() === '')
            throw new Error('McpApprovalDecision.deny(reason) requires a non-empty reason.');
        return new McpApprovalDecision(McpApprovalDecisionKind.DENY, reason, summary);
    }
}

/**
 * One remote tool as the server published it in `tools/list`, plus the `@Endpoint` operation reversed
 * from its hints by `operationForMcpHints`. A tool the server does not list is
 * {@link McpRemoteToolInfo.unknown}: operation {@link UNKNOWN_OPERATION}, no annotations.
 */
export class McpRemoteToolInfo {
    constructor(
        public readonly name: string,
        /** READ / WRITE / WRITE_IDEMPOTENT from `@webpieces/core-util`, or `UNKNOWN_OPERATION`. */
        public readonly operation: McpToolOperation,
        /** The annotations exactly as the server sent them; empty when it sent none. */
        public readonly annotations: ToolAnnotations,
        public readonly title: string | undefined,
        public readonly description: string | undefined,
        /** The tool's `inputSchema` as published; undefined only for an unknown tool. */
        public readonly inputSchema: Tool['inputSchema'] | undefined,
    ) {}

    // webpieces-disable no-function-outside-class -- named factory from the SDK's tool shape
    static fromTool(tool: Tool): McpRemoteToolInfo {
        return new McpRemoteToolInfo(
            tool.name,
            operationForMcpHints(tool.annotations),
            tool.annotations ?? {},
            tool.title,
            tool.description,
            tool.inputSchema,
        );
    }

    /** A name `tools/list` did not return to this caller. The server refuses it if the hook allows it. */
    // webpieces-disable no-function-outside-class -- named factory for a tool the server did not list
    static unknown(name: string): McpRemoteToolInfo {
        return new McpRemoteToolInfo(name, UNKNOWN_OPERATION, {}, undefined, undefined, undefined);
    }
}

/** What an {@link McpApprovalHook} is asked about: one `tools/call` that has NOT been sent. */
export class McpRemoteToolCall {
    constructor(
        public readonly tool: McpRemoteToolInfo,
        /** Exactly the arguments that will be sent if the hook allows the call. */
        public readonly args: Record<string, unknown>,
        /** The remote MCP endpoint `WpMcpRemote.connect` was given. */
        public readonly remoteUrl: string,
    ) {}
}

/**
 * The host's approval gate on a {@link WpMcpClient}, consulted on EVERY `callTool` before anything is
 * sent (#1422). It belongs to the HOST, not the MCP server: one server is called by coding agents
 * that run their own approval UI and by an app's chat service that shows its own cards, so a gate in
 * the server would break the hosts that approve their own way.
 *
 * - It runs on every call, so it must be cheap.
 * - It runs inside the caller's `RequestContext`, so it may read any key the app set.
 * - webpieces keeps NO approval state: what counts as approved, expiry, audit, single use and the
 *   card are the app's, carried to the hook through the app's own `RequestContext` keys.
 * - A hook that throws fails CLOSED: nothing is sent and the error propagates to the caller.
 *
 * `McpApprovalHooks.ALLOW_ALL` is today's behaviour, for a host that runs every tool it is handed.
 */
export interface McpApprovalHook {
    check(call: McpRemoteToolCall): McpApprovalDecision | Promise<McpApprovalDecision>;
}

/** The ALLOW_ALL hook: never consulted for metadata, never refuses. */
class McpAllowAllHook implements McpApprovalHook {
    check(_call: McpRemoteToolCall): McpApprovalDecision {
        return McpApprovalDecision.allow();
    }
}

/** The approval hooks webpieces ships. */
export class McpApprovalHooks {
    /**
     * Always ALLOW: every call is sent exactly as before the hook existed — byte for byte on the wire,
     * because a client holding it looks up no tool metadata and sends no extra `tools/list`. Choose
     * it only for a host that runs every tool it is given; a model can then call any WRITE tool.
     */
    static readonly ALLOW_ALL: McpApprovalHook = new McpAllowAllHook();
}

/** `structuredContent` of the result a REQUIRE_APPROVAL decision answers. */
export class McpApprovalPendingContent {
    readonly status = 'approval_required';

    constructor(
        public readonly tool: string,
        public readonly args: Record<string, unknown>,
        public readonly summary: string | undefined,
    ) {}
}

/** `structuredContent` of the result a DENY decision answers. */
export class McpApprovalDeniedContent {
    readonly status = 'denied';

    constructor(
        public readonly tool: string,
        public readonly reason: string,
        public readonly summary: string | undefined,
    ) {}
}

/**
 * A call {@link WpMcpClient} did NOT send because the hook answered REQUIRE_APPROVAL. The host's
 * client wrapper recognises the result with {@link McpApprovalRequired.from}, stores `{tool, args}`
 * and shows its card; the model only reads "waiting".
 */
export class McpApprovalRequired {
    private constructor(
        public readonly tool: string,
        public readonly args: Record<string, unknown>,
        public readonly summary: string | undefined,
    ) {}

    /** The pending call, or `undefined` for any result that is not an approval-required one. */
    // webpieces-disable no-function-outside-class -- recogniser of the approval-required result
    static from(result: CallToolResult): McpApprovalRequired | undefined {
        if (result._meta?.[MCP_APPROVAL_REQUIRED_META_KEY] !== true) return undefined;
        // Read structurally, not by instanceof: a host may have passed the result through JSON.
        const content = result.structuredContent;
        if (typeof content !== 'object' || content === null) return undefined;
        // webpieces-disable no-any-unknown -- structuredContent is the SDK's unknown JSON value
        const record = content as Record<string, unknown>;
        const tool = record['tool'];
        const args = record['args'];
        const summary = record['summary'];
        if (typeof tool !== 'string' || typeof args !== 'object' || args === null) return undefined;
        return new McpApprovalRequired(
            tool,
            // webpieces-disable no-any-unknown -- the call's arguments are arbitrary JSON
            args as Record<string, unknown>,
            typeof summary === 'string' ? summary : undefined,
        );
    }

    /** The result WpMcpClient answers in place of sending the call: a result, not an error. */
    // webpieces-disable no-function-outside-class -- the one builder of the approval-required result
    static result(tool: string, args: Record<string, unknown>, summary: string | undefined): CallToolResult {
        return {
            content: [{ type: 'text', text: `Waiting for approval: ${summary ?? tool}` }],
            structuredContent: new McpApprovalPendingContent(tool, args, summary),
            _meta: { [MCP_APPROVAL_REQUIRED_META_KEY]: true },
        };
    }
}

/** The result WpMcpClient answers for a DENY decision: a tool error carrying the reason. */
export class McpApprovalDenied {
    // webpieces-disable no-function-outside-class -- the one builder of the denied result
    static result(tool: string, reason: string, summary: string | undefined): CallToolResult {
        return {
            isError: true,
            content: [{ type: 'text', text: reason }],
            structuredContent: new McpApprovalDeniedContent(tool, reason, summary),
        };
    }
}
