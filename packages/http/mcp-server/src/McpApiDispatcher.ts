import {
    ApiBadRequestError,
    ApiErrorCodec,
    ApiErrorPayload,
    DtoSchemaBuilder,
    DtoValue,
    rolesRequired,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { RegisteredMcpTool } from './McpToolRegistry';
import { VerifiedMcpCredential } from './McpAuth';
import { MCP_INVOCATION_CONTEXT, McpInvocationContext } from './McpInvocationContext';

export class McpDispatchSuccess {
    readonly success = true;
    constructor(
        public readonly value: DtoValue,
        public readonly requestId: string,
    ) {}
}

export class McpDispatchFailure {
    readonly success = false;
    constructor(
        public readonly error: ApiErrorPayload,
        public readonly requestId: string,
    ) {}
}

export type McpDispatchResult = McpDispatchSuccess | McpDispatchFailure;

/** Executes through the explicit local or remote Webpieces client, never a controller reference. */
export class McpApiDispatcher {
    private readonly schemaBuilder = new DtoSchemaBuilder();

    async call(
        tool: RegisteredMcpTool,
        requestDto: DtoValue,
        credential: VerifiedMcpCredential,
        invocation: McpInvocationContext,
        endpointBearerToken?: string,
    ): Promise<McpDispatchResult> {
        return RequestContext.runDetachedScope(async () => {
            const headers = new Map<string, string[]>();
            if (tool.binding.topology === 'local') {
                if (!endpointBearerToken)
                    throw new Error(`Local MCP tool ${tool.name} has no endpoint JWT.`);
                headers.set('authorization', [`Bearer ${endpointBearerToken}`]);
            }
            const request = new HttpRequest('POST', `/__webpieces/mcp/${tool.name}`, headers);
            new RequestContextHeaders().fillFromRequest(request);
            RequestContext.putTrusted(MCP_INVOCATION_CONTEXT, invocation);
            if (tool.binding.topology === 'remote') {
                for (const tuple of credential.trustedContext)
                    RequestContext.putTrusted(tuple.key, tuple.value);
            }
            const requestId =
                RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID) ??
                'missing-request-id';
            const inputFailure = this.schemaBuilder.validate(tool.requestClass, requestDto);
            if (inputFailure) {
                return new McpDispatchFailure(
                    ApiErrorCodec.encode(
                        new ApiBadRequestError(
                            'MCP request DTO did not match its declared schema.',
                            undefined,
                            inputFailure.message,
                        ),
                    ),
                    requestId,
                );
            }
            const required = rolesRequired(tool.mcpAuth.requirement);
            if (
                required.length > 0 &&
                !required.some((role: string) => credential.listingRoles.includes(role))
            ) {
                return new McpDispatchFailure(
                    new ApiErrorPayload('forbidden', 'Forbidden'),
                    requestId,
                );
            }
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- protocol boundary sanitizes endpoint failures
            try {
                const value = (await tool.binding.invoke(tool.methodName, requestDto)) as DtoValue;
                return new McpDispatchSuccess(value, requestId);
            } catch (err: unknown) {
                const error = toError(err);
                return new McpDispatchFailure(ApiErrorCodec.encode(error), requestId);
            }
        });
    }
}
