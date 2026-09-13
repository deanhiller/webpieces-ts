import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequest,
    CallToolRequestSchema,
    CallToolResult,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { ApiErrorPayload, DtoValidationFailure, LogManager, toError } from '@webpieces/core-util';
import { ApiFactory, ClassType } from '@webpieces/http-routing';
import { VerifiedMcpCredential, WpMcpServerConfig } from './McpAuth';
import { McpApiDispatcher } from './McpApiDispatcher';
import { McpToolRegistry, RegisteredMcpTool } from './McpToolRegistry';

const log = LogManager.getLogger('WpMcpServer');

/** The only error shape rendered into model-visible MCP content. */
export class ModelVisibleToolError {
    constructor(
        public readonly kind: string,
        public readonly message: string,
        public readonly requestId?: string,
        public readonly field?: string,
        public readonly callerMessage?: string,
        public readonly errorCode?: string,
        public readonly retryAfterSeconds?: number,
    ) {}
}

/**
 * Node-only MCP adapter. Build one Server per authenticated transport/session; every tool call still
 * re-enters the endpoint's ordinary AuthFilter, so tools/list visibility never grants access.
 */
export class WpMcpServer {
    private readonly registry: McpToolRegistry;
    private readonly dispatcher: McpApiDispatcher;

    constructor(
        private readonly config: WpMcpServerConfig,
        apiFactory: ApiFactory,
        apiClasses: readonly ClassType[],
    ) {
        this.registry = new McpToolRegistry(apiClasses);
        this.dispatcher = new McpApiDispatcher(apiFactory);
    }

    async build(accessToken: string): Promise<Server> {
        const credential = await this.config.tokenVerifier.verify(
            accessToken,
            this.config.resource,
        );
        this.validateCredential(credential);
        return this.buildForCredential(credential);
    }

    protectedResourceMetadata(): ReturnType<WpMcpServerConfig['protectedResourceMetadata']> {
        return this.config.protectedResourceMetadata();
    }

    private buildForCredential(credential: VerifiedMcpCredential): Server {
        const server = new Server(
            // webpieces-disable no-anonymous-object-literals -- external MCP SDK request structure
            { name: this.config.name, version: this.config.version },
            // webpieces-disable no-anonymous-object-literals -- external MCP SDK capability structure
            { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, () => ({
            tools: this.registry.tools
                .filter((tool: RegisteredMcpTool) => tool.isVisibleTo(credential.listingRoles))
                .map((tool: RegisteredMcpTool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    outputSchema: tool.outputSchema,
                    annotations: tool.annotations,
                })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
            const tool = this.registry.find(request.params.name);
            if (!tool) {
                throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
            }
            return this.call(tool, request.params.arguments, credential);
        });
        return server;
    }

    private validateCredential(credential: VerifiedMcpCredential): void {
        if (credential.resource !== this.config.resource) {
            throw new Error('MCP access token was not issued for this protected resource.');
        }
        if (!this.config.authorizationServers.includes(credential.issuer)) {
            throw new Error('MCP access token issuer is not trusted by this protected resource.');
        }
        if (credential.expiresAtEpochSeconds <= Date.now() / 1000) {
            throw new Error('MCP access token has expired.');
        }
        for (const scope of this.config.requiredScopes) {
            if (!credential.scopes.includes(scope)) {
                throw new Error(`MCP access token is missing required scope '${scope}'.`);
            }
        }
        if (credential.endpointBearerToken.trim() === '') {
            throw new Error('MCP verifier returned an empty endpoint bearer credential.');
        }
    }

    private async call(
        tool: RegisteredMcpTool,
        args: unknown,
        credential: VerifiedMcpCredential,
    ): Promise<CallToolResult> {
        const inputFailure = this.registry.schemaBuilder.validate(tool.requestClass, args ?? {});
        if (inputFailure) return this.inputError(inputFailure);
        const result = await this.dispatcher.call(tool, args ?? {}, credential.endpointBearerToken);
        if (!result.success) return this.apiError(result.error, result.requestId);

        const outputFailure = this.registry.schemaBuilder.validate(tool.responseClass, result.value);
        if (outputFailure) {
            log.error(
                `MCP output schema violation for ${tool.apiClass.name}.${tool.methodName}: ${outputFailure.message}`,
            );
            return this.errorResult(
                new ModelVisibleToolError('implementation', 'Internal Error', result.requestId),
            );
        }
        let structured: Record<string, unknown>;
        // webpieces-disable no-unmanaged-exceptions -- serialization failures become safe tool errors
        try {
            structured = this.record(result.value);
            // webpieces-disable catch-error-pattern -- the model sees a generic error; details stay in logs
        } catch (error: unknown) {
            log.error(
                `MCP response serialization failed for ${tool.apiClass.name}.${tool.methodName}`,
                toError(error),
            );
            return this.errorResult(
                new ModelVisibleToolError('implementation', 'Internal Error', result.requestId),
            );
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
        };
    }

    private inputError(failure: DtoValidationFailure): CallToolResult {
        return this.errorResult(new ModelVisibleToolError('bad-request', failure.message));
    }

    private apiError(payload: ApiErrorPayload, requestId: string): CallToolResult {
        return this.errorResult(
            new ModelVisibleToolError(
                payload.kind,
                payload.message,
                requestId,
                payload.field,
                payload.callerMessage,
                payload.errorCode,
                payload.retryAfterSeconds,
            ),
        );
    }

    private errorResult(error: ModelVisibleToolError): CallToolResult {
        const structured = this.record(error);
        return {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError: true,
        };
    }

    private record(value: unknown): Record<string, unknown> {
        const json = JSON.stringify(value);
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            // webpieces-disable no-anonymous-object-literals -- external MCP structured-content wrapper
            return { value: parsed };
        }
        return parsed as Record<string, unknown>;
    }
}
