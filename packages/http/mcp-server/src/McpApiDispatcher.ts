import { ApiErrorCodec, ApiErrorPayload, WebpiecesCoreHeaders } from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ApiFactory, ApiClientProxy } from '@webpieces/http-routing';
import { RegisteredMcpTool } from './McpToolRegistry';

export class McpDispatchSuccess {
    readonly success = true;
    constructor(public readonly value: unknown, public readonly requestId: string) {}
}

export class McpDispatchFailure {
    readonly success = false;
    constructor(public readonly error: ApiErrorPayload, public readonly requestId: string) {}
}

export type McpDispatchResult = McpDispatchSuccess | McpDispatchFailure;

/** Executes one tool through the same ApiFactory proxy/filter/controller path as HTTP. */
export class McpApiDispatcher {
    constructor(private readonly apiFactory: ApiFactory) {}

    async call(
        tool: RegisteredMcpTool,
        requestDto: unknown,
        endpointBearerToken: string,
    ): Promise<McpDispatchResult> {
        const headers = new Map<string, string[]>();
        headers.set('authorization', [`Bearer ${endpointBearerToken}`]);
        const request = new HttpRequest('POST', `/__webpieces/mcp/${tool.name}`, headers);
        return RequestContext.run(async () => {
            new RequestContextHeaders().fillFromRequest(request);
            const requestId =
                RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID) ?? 'missing-request-id';
            // webpieces-disable no-unmanaged-exceptions -- this boundary sanitizes every endpoint throw
            try {
                const client = this.apiFactory.createApiClient<ApiClientProxy>(tool.apiClass);
                const value = await client[tool.methodName](requestDto);
                return new McpDispatchSuccess(value, requestId);
                // webpieces-disable catch-error-pattern -- convert every throw through the safe codec
            } catch (error: unknown) {
                return new McpDispatchFailure(ApiErrorCodec.encode(error), requestId);
            }
        });
    }
}
