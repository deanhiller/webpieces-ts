/* eslint-disable */
import { ApiPath, ApiType, AuthorizationType, Endpoint, MCP, POST, READ, RPC, WpAuthorization, WpAuthPublic, WpMcpTool } from '@webpieces/core-util';

export class GuessRequest {
    /** The guess. */
    guess!: string;
}

/** Whether the guess was right. */
export class GuessResponse {
    /** True when it was. */
    right!: boolean;
}

/** Agent tools only: an undocumented DTO is refused for MCP output too (#1292). */
@ApiPath('/guess')
@ApiType(MCP)
export class McpOnlyUndocumentedApi {
    /**
     * Checks a guess.
     *
     * @summary Check a guess
     * @returns Whether the guess was right.
     */
    @Endpoint(POST, '/check', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('check_guess')
    check(request: GuessRequest): Promise<GuessResponse> {
        throw new Error('contract');
    }
}
