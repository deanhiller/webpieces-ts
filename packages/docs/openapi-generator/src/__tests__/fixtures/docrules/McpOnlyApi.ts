/* eslint-disable */
import { ApiPath, ApiType, AuthorizationType, Endpoint, MCP, POST, READ, RPC, WpAuthorization, WpAuthPublic, WpMcpTool } from '@webpieces/core-util';

/** What to ask the agent tool. */
export class AskRequest {
    /** The question. */
    question!: string;
}

/** The agent tool's answer. */
export class AskResponse {
    /** The answer. */
    answer!: string;
}

/** Agent tools only: the MCP output is held to the same description rules (#1292). */
@ApiPath('/ask')
@ApiType(MCP)
export class McpOnlyApi {
    /** Asks a question; it has no returns tag, refused although this contract feeds only MCP output. */
    @Endpoint(POST, '/ask', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('ask_question', 'Ask a question')
    ask(request: AskRequest): Promise<AskResponse> {
        throw new Error('contract');
    }
}
