import {
    ApiErrorCodec,
    ApiErrorPayload,
    DtoValue,
    toError,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';
import { HttpRequest, RequestContext, RequestContextHeaders } from '@webpieces/core-context';
import { ApiFactory, ApiClientProxy } from '@webpieces/http-routing';
import { RegisteredMcpTool } from './McpToolRegistry';

export class McpDispatchSuccess {
    readonly success = true;
    constructor(public readonly value: DtoValue, public readonly requestId: string) {}
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
        requestDto: DtoValue,
        endpointBearerToken: string,
    ): Promise<McpDispatchResult> {
        const headers = new Map<string, string[]>();
        headers.set('authorization', [`Bearer ${endpointBearerToken}`]);
        const request = new HttpRequest('POST', `/__webpieces/mcp/${tool.name}`, headers);
        return RequestContext.run(async () => {
            new RequestContextHeaders().fillFromRequest(request);
            const requestId =
                RequestContext.getUntrusted(WebpiecesCoreHeaders.REQUEST_ID) ?? 'missing-request-id';
            // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- transport boundary sanitizes endpoint throws
            try {
                const client = this.apiFactory.createApiClient<ApiClientProxy>(tool.apiClass as never);
                const value = (await client[tool.methodName](requestDto)) as DtoValue;
                return new McpDispatchSuccess(value, requestId);
            } catch (err: unknown) {
                const error = toError(err);
                return new McpDispatchFailure(ApiErrorCodec.encode(error), requestId);
            }
        });
    }
}
