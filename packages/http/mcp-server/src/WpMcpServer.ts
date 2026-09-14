import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequest,
    CallToolRequestSchema,
    CallToolResult,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
    ApiErrorPayload,
    ApiUnauthorizedError,
    DtoValue,
    LogManager,
    toError,
} from '@webpieces/core-util';
import { ApiFactory, ClassType, MintedJwt } from '@webpieces/http-routing';
import {
    MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
    McpEndpointDescriptor,
    McpProtectedResourceMetadata,
    VerifiedMcpCredential,
    WpMcpServerConfig,
} from './McpAuth';
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
export class WpMcpServer<TGrant, TMintRequest> {
    private readonly registry: McpToolRegistry;
    private readonly dispatcher: McpApiDispatcher;

    constructor(
        private readonly config: WpMcpServerConfig<TGrant, TMintRequest>,
        apiFactory: ApiFactory,
        apiClasses: readonly ClassType[],
    ) {
        this.registry = new McpToolRegistry(apiClasses);
        this.dispatcher = new McpApiDispatcher(apiFactory);
    }

    async build(accessToken: string): Promise<Server> {
        await this.verifyCredential(accessToken);
        return this.buildForAccessToken(accessToken);
    }

    protectedResourceMetadata(): McpProtectedResourceMetadata {
        return this.config.protectedResourceMetadata();
    }

    private buildForAccessToken(accessToken: string): Server {
        const server = new Server(
            // webpieces-disable no-anonymous-object-literals -- external MCP SDK request structure
            { name: this.config.name, version: this.config.version },
            // webpieces-disable no-anonymous-object-literals -- external MCP SDK capability structure
            { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            const credential = await this.verifyCredential(accessToken);
            return {
                tools: this.registry.tools
                    .filter((tool: RegisteredMcpTool) => tool.isVisibleTo(credential.listingRoles))
                    .map((tool: RegisteredMcpTool) => ({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        outputSchema: tool.outputSchema,
                        annotations: tool.annotations,
                    })),
            };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
            const tool = this.registry.find(request.params.name);
            if (!tool) {
                throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
            }
            return this.call(tool, request.params.arguments ?? {}, accessToken);
        });
        return server;
    }

    private async verifyCredential(accessToken: string): Promise<VerifiedMcpCredential> {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- security boundary logs owner detail and exposes only a generic authentication failure
        try {
            const credential = await this.config.accessTokenAuthority.verifyAccessToken(
                accessToken,
                this.config.resource,
            );
            this.validateCredential(credential);
            return credential;
        } catch (err: unknown) {
            const error = toError(err);
            log.warn('MCP access-token verification rejected a request', error);
            throw new ApiUnauthorizedError('MCP access token rejected.', undefined, error);
        }
    }

    private validateCredential(credential: VerifiedMcpCredential): void {
        const now = Math.floor(Date.now() / 1000);
        if (credential.subject.trim() === '') {
            throw new Error('MCP access token has no subject.');
        }
        if (
            !Number.isFinite(credential.issuedAtEpochSeconds) ||
            !Number.isFinite(credential.expiresAtEpochSeconds) ||
            !Number.isFinite(credential.accountValidatedAtEpochSeconds)
        ) {
            throw new Error('MCP access token security timestamps must be finite.');
        }
        if (credential.resource !== this.config.resource) {
            throw new Error('MCP access token was not issued for this protected resource.');
        }
        if (!this.config.authorizationServers.includes(credential.issuer)) {
            throw new Error('MCP access token issuer is not trusted by this protected resource.');
        }
        if (credential.issuedAtEpochSeconds > now) {
            throw new Error('MCP access token was issued in the future.');
        }
        if (credential.expiresAtEpochSeconds <= now) {
            throw new Error('MCP access token has expired.');
        }
        if (
            credential.expiresAtEpochSeconds - credential.issuedAtEpochSeconds >
            MAX_MCP_ACCESS_TOKEN_LIFETIME_SECONDS
        ) {
            throw new Error('MCP access token lifetime exceeds 30 days.');
        }
        for (const scope of this.config.requiredScopes) {
            if (!credential.scopes.includes(scope)) {
                throw new Error(`MCP access token is missing required scope '${scope}'.`);
            }
        }
        if (
            credential.accountValidatedAtEpochSeconds > now ||
            now - credential.accountValidatedAtEpochSeconds > this.config.maxAccountValidationAgeSeconds
        ) {
            throw new Error('MCP account authorization state is not fresh enough for dispatch.');
        }
    }

    private async call(
        tool: RegisteredMcpTool,
        args: DtoValue,
        accessToken: string,
    ): Promise<CallToolResult> {
        let credential: VerifiedMcpCredential;
        // webpieces-disable no-unmanaged-exceptions -- MCP transport boundary normalizes authentication failures before they reach the model
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- MCP transport boundary
        try {
            credential = await this.verifyCredential(accessToken);
        } catch (err: unknown) {
            //const error = toError(err);
            throw new McpError(ErrorCode.InvalidRequest, 'Unauthorized');
        }
        let endpointJwt: MintedJwt;
        // webpieces-disable no-unmanaged-exceptions -- MCP transport boundary logs mint failures and exposes only a generic protocol error
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- MCP transport boundary
        try {
            const descriptor = new McpEndpointDescriptor(
                tool.name,
                tool.apiClass.name,
                tool.methodName,
            );
            const mintRequest = this.config.endpointMintRequest(credential, descriptor);
            endpointJwt = await this.config.endpointJwtAuthority.mint(mintRequest);
            this.validateEndpointJwt(endpointJwt, accessToken);
        } catch (err: unknown) {
            const error = toError(err);
            log.error(
                `MCP endpoint credential mint failed for ${tool.apiClass.name}.${tool.methodName}`,
                error,
            );
            throw new McpError(ErrorCode.InternalError, 'Internal Error');
        }
        const result = await this.dispatcher.call(tool, args ?? {}, endpointJwt.token);
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
        let structured: Record<string, DtoValue>;
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- transport boundary sanitizes serialization failures
        try {
            structured = this.record(result.value);
        } catch (err: unknown) {
            const error = toError(err);
            log.error(
                `MCP response serialization failed for ${tool.apiClass.name}.${tool.methodName}`,
                error,
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

    private validateEndpointJwt(endpointJwt: MintedJwt, accessToken: string): void {
        const now = Math.floor(Date.now() / 1000);
        if (endpointJwt.token === accessToken) {
            throw new Error('MCP access-token passthrough to endpoint dispatch is forbidden.');
        }
        if (endpointJwt.expiresAtEpochSeconds <= now) {
            throw new Error('MCP endpoint JWT has already expired.');
        }
        if (
            endpointJwt.expiresAtEpochSeconds - now >
            this.config.maxEndpointJwtLifetimeSeconds
        ) {
            throw new Error('MCP endpoint JWT lifetime exceeds the configured one-hour ceiling.');
        }
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

    private record(value: DtoValue): Record<string, DtoValue> {
        const json = JSON.stringify(value);
        if (json === undefined) throw new Error('MCP structured content is not JSON serializable.');
        const parsed = JSON.parse(json) as DtoValue;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            // webpieces-disable no-anonymous-object-literals -- external MCP structured-content wrapper
            return { value: parsed };
        }
        return parsed as Record<string, DtoValue>;
    }
}
