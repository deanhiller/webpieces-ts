/* eslint-disable */
import { ApiPath, ApiType, Endpoint, MCP, POST, READ, RPC, WpAuthPublic, WpMcpTool } from '@webpieces/core-util';
import { AiProvider } from '@fixture/company-core';

/** Which provider to ask. */
export interface ProviderRequest {
    /** The provider. */
    provider: AiProvider;
}

/** The answer. */
export interface ProviderResponse {
    /** What it said. */
    answer: string;
}

/** Agent tools only. */
@ApiPath('/agent')
@ApiType(MCP)
export class AgentApi {
    /** Asks a provider. */
    @Endpoint(POST, '/ask', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpMcpTool('ask_provider')
    ask(request: ProviderRequest): Promise<ProviderResponse> {
        throw new Error('contract');
    }
}
