import { createHash } from 'node:crypto';
import {
    CallToolRequest,
    CallToolResult,
    Implementation,
    ListToolsResult,
    McpServer,
    ProgressToken,
    ProtocolError,
    ServerContext,
    ServerOptions,
    Tool,
} from '@modelcontextprotocol/server';
import {
    ApiErrorBoundary,
    ApiImplementationError,
    ApiJsonSchemaValidator,
    ApiMethodInfo,
    ApiUnauthorizedError,
    DtoValue,
    LogApiCallImpl,
    LogManager,
    Mcp,
    McpInvocationContext,
    McpProgressReporter,
    McpToolProfiles,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { RequestContext, RequestContextApiCallContext } from '@webpieces/core-context';
import {
    AuthorizationService,
    CanonicalUserRoles,
    VERIFIED_MACHINE_CALLER,
    VerifiedMachineCaller,
} from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { McpApiDispatcher } from './McpApiDispatcher';
import { McpProtocol } from './McpProtocol';
import { McpToolCatalog } from './McpToolCatalog';
import { McpCorrelation } from './McpToolCallRendering';
import { McpToolDeniedError } from './McpToolPolicy';
import { AuthorizedMcpTools, McpToolRegistry, RegisteredMcpTool } from './McpToolRegistry';
import { WpMcpErrorTranslator } from './WpMcpErrorTranslator';

const log = LogManager.getLogger('McpToolset');

/**
 * The request DTO the edge `LogApiCall` lines report. These boundaries run outside any API dispatch,
 * so there is no contract DTO to log; the step name is the fact worth having.
 */
class McpEdgeRequest {
    constructor(public readonly step: string) {}
}

class McpSdkOperation {
    toolStage = false;
    constructor(public readonly name: string) {}
}

/**
 * `Tool.annotations` exactly as tools/list publishes it: the four hints PLUS the human-readable
 * `title` (#1180). The Claude Connectors Directory checks `annotations.title`; clients on the
 * 2025-06-18+ spec render the top-level `Tool.title`, so both carry the one title — the method's
 * `@summary` JSDoc tag, read from the generated catalog (#1296).
 */
class McpPublishedToolAnnotations {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;

    constructor(tool: RegisteredMcpTool) {
        this.title = tool.title;
        this.readOnlyHint = tool.annotations.readOnlyHint;
        this.destructiveHint = tool.annotations.destructiveHint;
        this.idempotentHint = tool.annotations.idempotentHint;
        this.openWorldHint = tool.annotations.openWorldHint;
    }
}

/**
 * What ONE MCP request may see and how it is cancelled, established by the transport before the SDK
 * handler runs: the caller's authorized projection, and the signal that fires when the caller goes away.
 */
export class McpToolRequest {
    constructor(
        public readonly tools: AuthorizedMcpTools,
        public readonly disconnectSignal: AbortSignal,
    ) {}
}

/**
 * The official SDK server with Webpieces-owned tools/list and tools/call handlers. It answers
 * `toolInputSchemaJson` from the request-authorized view when the transport has one, so the SDK's
 * pre-dispatch SEP-2243 `Mcp-Param-*` header validation still runs without registering SDK-side tool
 * callbacks.
 */
class WpSdkMcpServer extends McpServer {
    constructor(
        info: Implementation,
        options: ServerOptions,
        private readonly schemaSource: (name: string) => RegisteredMcpTool | undefined,
    ) {
        super(info, options);
    }

    // webpieces-disable no-any-unknown -- signature is fixed by the SDK's JSON Schema record type
    override toolInputSchemaJson(name: string): Record<string, unknown> | undefined {
        return this.schemaSource(name)?.inputSchema as Record<string, DtoValue> | undefined;
    }
}

/**
 * McpToolset — the shared core of every MCP transport: WHICH tools are served, and everything that
 * happens to a request once its caller is established.
 *
 * ```ts
 * const toolset = new McpToolset(
 *     bindings,                                              // McpApiBinding.local / .remote
 *     McpToolCatalog.fromPackages(['@myorg/my-apis'], __dirname),
 *     router.authorizationService(),
 *     ['user'],                                              // #1187 profiles: WHICH tools this toolset serves
 * );
 * const client = await WpMcpInMemory.connect(toolset);       // in-process agent
 * new WpMcpServer(config, toolset).bind(app, options);       // HTTP
 * ```
 *
 * It owns the {@link McpToolRegistry}, the per-caller {@link AuthorizedMcpTools} projection, input and
 * output schema validation, dispatch through `binding.invoke`, and the error translation. Its ONLY input
 * about the caller is the CURRENT `RequestContext` — the trusted USER_ID / USER_ROLES / ORG_ID and a
 * `VerifiedMachineCaller`, exactly what `AuthorizationService.authorize` reads. A transport's only job
 * is to establish that context; `@WpAuthorization` on the contract is the single policy everywhere.
 *
 * Profiles are fixed per toolset: `/mcp/user` and `/mcp/admin` are two toolsets (two servers), so paths
 * split by WHICH TOOLS, never by HOW THE CALLER AUTHENTICATES.
 *
 * Before tools/list and tools/call hand an IMPLEMENTATION-kind failure to the translator, they
 * `log.error` it with its stack and the requestId ({@link logImplementationFailure}, #1055). The
 * translator reduces such a failure to "Internal Error" for the caller, so that line is the only place
 * its cause exists.
 */
export class McpToolset {
    readonly registry: McpToolRegistry;
    readonly profiles: readonly string[];
    /** A short hash of the served tool surface, appended to every server version and tool `_meta`. */
    readonly revision: string;
    private readonly dispatcher = new McpApiDispatcher();
    /** Classifies a failure exactly as the translator will render it, so the two cannot disagree. */
    private readonly boundary = new ApiErrorBoundary();
    private readonly outputSchemas = new ApiJsonSchemaValidator();
    /**
     * tools/list has NO filter chain above it — `LogApiFilter` never sees a list the SDK renders. Wrapping
     * it in `LogApiCall` is this repo's one line on logging.
     */
    private readonly logApiCall = new LogApiCallImpl(new RequestContextApiCallContext());
    /** tools/call reads `McpRegistry`; tools/list replies stay framework-owned. See McpErrorTranslator. */
    private readonly translator: WpMcpErrorTranslator = new WpMcpErrorTranslator();

    constructor(
        bindings: readonly McpApiBinding[],
        /**
         * The tools the build published — ONE catalog per bound contract, each the
         * `mcp-<ContractClass>-tools.json` `wp-openapi` wrote beside its library's OpenAPI documents,
         * read with `McpToolCatalog.fromPackages([...], __dirname)`. The only source of a tool's
         * documentation and schemas; `McpToolRegistry` refuses to build unless it holds exactly one
         * catalog per bound contract.
         */
        catalogs: readonly McpToolCatalog[],
        public readonly authorizationService: AuthorizationService,
        /** The union of `@WpMcpTool` profiles this toolset serves, at least one (`[Mcp.DEFAULT]` for untagged tools). */
        profiles: McpToolProfiles,
    ) {
        if (bindings.length === 0)
            throw new Error('McpToolset requires at least one API contract binding.');
        this.profiles = Mcp.profiles(profiles, 'McpToolset profiles');
        this.registry = new McpToolRegistry(bindings, catalogs, authorizationService);
        this.revision = this.calculateRevision();
    }

    /** The tools the caller in the CURRENT RequestContext may see, sorted by name. */
    async authorizedTools(): Promise<AuthorizedMcpTools> {
        return AuthorizedMcpTools.create(this.registry, this.authorizationService, this.profiles);
    }

    /**
     * A fresh SDK server whose tools/list and tools/call are this toolset's. `request` establishes, per
     * MCP request, what the caller may see; `schemaView` answers the SDK's input-schema lookup (the HTTP
     * transport passes the request's projection, the in-memory one the full registry).
     */
    createSdkServer(
        info: Implementation,
        options: ServerOptions,
        request: () => Promise<McpToolRequest>,
        schemaView: (name: string) => RegisteredMcpTool | undefined,
    ): McpServer {
        const server = new WpSdkMcpServer(info, options, schemaView);
        server.server.removeRequestHandler('tools/list');
        server.server.removeRequestHandler('tools/call');
        server.server.setRequestHandler(
            'tools/list',
            async (_request: object): Promise<ListToolsResult> =>
                this.sdkBoundary(new McpSdkOperation('tools/list'), () =>
                    this.logEdge('tools/list', async () => this.listTools((await request()).tools)),
                ) as Promise<ListToolsResult>,
        );
        server.server.setRequestHandler(
            'tools/call',
            async (call: CallToolRequest, sdkContext: ServerContext): Promise<CallToolResult> =>
                this.handleCallTool(server, call, request, sdkContext),
        );
        return server;
    }

    /** Run one un-filtered edge step under `LogApiCall`, so its failure gets exactly one log line. */
    async logEdge<R>(step: string, work: () => Promise<R>): Promise<R> {
        return this.logApiCall.execute(
            new ApiMethodInfo('server', 'McpEndpoint', step, McpProtocol),
            new McpEdgeRequest(step),
            work,
        );
    }

    /** ONE SDK callback catch implementation; the SDK intercepts foreign throws itself. */
    private async sdkBoundary<R>(
        operation: McpSdkOperation,
        work: () => Promise<R>,
    ): Promise<R | CallToolResult> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- shared SDK response boundary, preserving protocol versus tool envelopes
        try {
            return await work();
        } catch (err: unknown) {
            const error = toError(err);
            if (error instanceof McpToolDeniedError)
                throw this.translator.unknownTool(error.toolName);
            if (!operation.toolStage && error instanceof ProtocolError) throw error;
            this.logImplementationFailure(operation.name, error);
            if (operation.toolStage) return this.translator.toToolCallResult(error);
            this.translator.toListError(error);
        }
    }

    private listTools(view: AuthorizedMcpTools): ListToolsResult {
        const tools: Tool[] = view.tools.map((tool: RegisteredMcpTool) =>
            this.toolDefinition(tool),
        );
        return { tools };
    }

    private toolDefinition(tool: RegisteredMcpTool): Tool {
        return {
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema as Tool['inputSchema'],
            outputSchema: tool.outputSchema as Tool['outputSchema'],
            annotations: new McpPublishedToolAnnotations(tool),
            _meta: { webpiecesRegistryRevision: this.revision },
        };
    }

    /**
     * SDK tool callback: an unknown or hidden tool is a JSON-RPC -32602; every failure after the tool
     * is found is an `isError: true` result, identically for local and remote bindings.
     */
    private async handleCallTool(
        server: McpServer,
        call: CallToolRequest,
        request: () => Promise<McpToolRequest>,
        sdkContext: ServerContext,
    ): Promise<CallToolResult> {
        const name = call.params.name;
        const operation = new McpSdkOperation(`tools/call ${name}`);
        return this.sdkBoundary(operation, async () => {
            McpCorrelation.stamp(new McpCorrelation(sdkContext.mcpReq.id, McpProtocol, name));
            const established = await request();
            const tool = established.tools.find(name);
            if (!tool) throw this.translator.unknownTool(name);
            McpCorrelation.stamp(
                new McpCorrelation(sdkContext.mcpReq.id, tool.apiClass, name, tool.operation),
            );
            operation.toolStage = true;
            const result = await this.callTool(tool, call, established, sdkContext);
            result._meta = this.translator.resultMeta(McpCorrelation.requestId());
            return server.server.projectCallToolResult(
                result,
                tool.outputSchema as Record<string, DtoValue>,
            );
        }) as Promise<CallToolResult>;
    }

    /**
     * ONE `log.error` line, with the stack and the requestId, for a failure that is THIS server's bug
     * — the `implementation` kind, which the translator reduces to "Internal Error" and a requestId
     * for the caller (#1055).
     *
     * `LogApiCall` does not cover this. An MCP output-schema violation is raised AFTER the controller
     * returned, so the only `LogApiCall` line for that call reads `resp-SUCCESS`; before this line
     * existed, the requestId support was handed led to a log with no error in it. Where a
     * `[API-*-resp-FAIL]` line does exist it carries the error's message, not its stack. So this line
     * is not the bare duplicate `ApiErrorBoundary` stopped writing: it is the one that says WHERE.
     *
     * Every other kind (bad-request, end-user, dependency, ...) is a caller's or a downstream's
     * failure, published to the caller with its own text, and `LogApiCall` already records it.
     */
    private logImplementationFailure(entryPoint: string, error: Error): void {
        if (this.boundary.encode(error).kind !== 'implementation') return;
        log.error(
            `MCP ${entryPoint} failed with an implementation error requestId=${McpCorrelation.requestId()}`,
            error,
        );
    }

    /** Everything a tool call does. No catch in here: failures propagate to handleCallTool. */
    private async callTool(
        tool: RegisteredMcpTool,
        call: CallToolRequest,
        established: McpToolRequest,
        sdkContext: ServerContext,
    ): Promise<CallToolResult> {
        const caller = this.currentCaller();
        const invocation = new McpInvocationContext(
            sdkContext.mcpReq.id,
            tool.name,
            caller.subject,
            caller.roles,
            AbortSignal.any([sdkContext.mcpReq.signal, established.disconnectSignal]),
            this.progressReporter(sdkContext),
        );
        const args = (call.params.arguments ?? {}) as DtoValue;
        const value = await this.dispatcher.call(tool, args, invocation, this.authorizationService);
        const outputFailure = this.outputSchemas.validate(tool.outputSchema, value);
        if (outputFailure) {
            throw new ApiImplementationError(
                `MCP output schema violation for ${tool.apiClass.name}.${tool.methodName}: ${outputFailure.message}`,
            );
        }
        const structured = this.record(value);
        return {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
        };
    }

    /** The trusted caller of the CURRENT RequestContext: a verified user, else a verified machine. */
    private currentCaller(): McpCallerFacts {
        const userId = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID);
        if (typeof userId === 'string' && userId.trim() !== '') {
            return new McpCallerFacts(userId, CanonicalUserRoles.read());
        }
        const machine = RequestContext.getTrusted(VERIFIED_MACHINE_CALLER);
        if (machine instanceof VerifiedMachineCaller)
            return new McpCallerFacts(machine.identity, []);
        throw new ApiUnauthorizedError(
            'MCP tool call has no trusted caller in its RequestContext.',
        );
    }

    private progressReporter(context: ServerContext): McpProgressReporter | undefined {
        const token = context.mcpReq._meta?.progressToken;
        if (token === undefined) return undefined;
        return async (progress: number, total?: number, message?: string): Promise<void> => {
            await context.mcpReq.notify({
                method: 'notifications/progress',
                params: this.progressParams(token, progress, total, message),
            });
        };
    }

    private progressParams(
        progressToken: ProgressToken,
        progress: number,
        total?: number,
        message?: string,
    ): Record<string, DtoValue> {
        const params: Record<string, DtoValue> = { progressToken, progress };
        if (total !== undefined) params['total'] = total;
        if (message !== undefined) params['message'] = message;
        return params;
    }

    private calculateRevision(): string {
        const surface = this.registry.tools.map((tool: RegisteredMcpTool) => [
            tool.name,
            tool.title,
            tool.description,
            tool.inputSchema,
            tool.outputSchema,
            tool.annotations,
            tool.profiles,
        ]);
        return createHash('sha256')
            .update(JSON.stringify([this.profiles, surface]))
            .digest('hex')
            .slice(0, 12);
    }

    private record(value: DtoValue): Record<string, DtoValue> {
        const jsonValue = JSON.stringify(value);
        if (jsonValue === undefined) {
            throw new ApiImplementationError('MCP structured content is not JSON serializable.');
        }
        const parsed = JSON.parse(jsonValue) as DtoValue;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { value: parsed };
        }
        return parsed as Record<string, DtoValue>;
    }
}

/** Who the current RequestContext says is calling, as McpInvocationContext reports it. */
class McpCallerFacts {
    constructor(
        public readonly subject: string,
        public readonly roles: readonly string[],
    ) {}
}
