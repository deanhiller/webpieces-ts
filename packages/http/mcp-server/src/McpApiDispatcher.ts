import {
    ApiBadRequestError,
    ApiForbiddenError,
    ApiImplementationError,
    ApiJsonSchemaValidator,
    DtoValue,
    rolesRequired,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { RegisteredMcpTool } from './McpToolRegistry';
import { VerifiedMcpCredential } from './McpAuth';
import { MCP_INVOCATION_CONTEXT, McpInvocationContext } from './McpInvocationContext';

/**
 * Executes one tool call through the explicit local or remote Webpieces client, never a controller
 * reference. It has NO try/catch: every failure (bad arguments, MCP authorization, anything the local
 * proxy or the remote generated client throws) propagates as a typed error to the single tools/call
 * boundary in `WpMcpServer`, so local and remote bindings are translated identically.
 */
export class McpApiDispatcher {
    private readonly schemas = new ApiJsonSchemaValidator();

    async call(
        tool: RegisteredMcpTool,
        requestDto: DtoValue,
        credential: VerifiedMcpCredential,
        invocation: McpInvocationContext,
        endpointBearerToken?: string,
    ): Promise<DtoValue> {
        const inputFailure = this.schemas.validate(tool.inputSchema, requestDto);
        if (inputFailure) {
            throw new ApiBadRequestError(
                `MCP arguments for ${tool.name} did not match its published input schema: ${inputFailure.message}`,
                inputFailure.field,
                inputFailure.message,
            );
        }
        const required = rolesRequired(tool.mcpAuth.requirement);
        if (
            required.length > 0 &&
            !required.some((role: string) => credential.listingRoles.includes(role))
        ) {
            throw new ApiForbiddenError(
                `MCP principal ${credential.subject} lacks a role required by @WpMcpAuthJwt on ${tool.name}.`,
            );
        }
        const parentRequestId = RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID);
        return RequestContext.runDetachedScope(async () => {
            if (parentRequestId) {
                RequestContext.putUntrusted(WebpiecesCoreHeaders.REQUEST_ID, parentRequestId);
            }
            const headers = new Map<string, string[]>();
            if (tool.binding.topology === 'local') {
                if (!endpointBearerToken) {
                    throw new ApiImplementationError(
                        `Local MCP tool ${tool.name} has no endpoint JWT.`,
                    );
                }
                headers.set('authorization', [`Bearer ${endpointBearerToken}`]);
            }
            const request = new HttpRequest('POST', `/__webpieces/mcp/${tool.name}`, headers);
            new RequestContextHeaders().fillFromRequest(request);
            RequestContext.putTrusted(MCP_INVOCATION_CONTEXT, invocation);
            // THIS hop is the edge, and its caller is a model. Stamped here rather than in
            // `AuthFilter` because the local binding's HTTP auth mode describes the bridge's own
            // endpoint JWT, not the LLM on the other end of it — `@WpMcpAuthJwt` is separate
            // metadata and never reaches an `AuthMode`. `AuthFilter` only ever SETS a surface when
            // none arrived, so this one survives the filter chain the invocation runs through.
            RequestContext.putTrusted(WebpiecesCoreHeaders.SURFACE, 'llm');
            if (tool.binding.topology === 'remote') {
                for (const tuple of credential.trustedContext)
                    RequestContext.putTrusted(tuple.key, tuple.value);
            }
            return tool.binding.invoke(tool.methodName, requestDto);
        });
    }
}
