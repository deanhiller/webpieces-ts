import { WpAuthorization, AuthorizationType, WpAuth, jwt as jwtAuth } from '@webpieces/core-util';
import { ApiPath, ApiType, Endpoint, MCP, POST, READ, RPC, WpMcpTool } from '@webpieces/core-util';

/** A function, which no document publishes. */
export function helperOf(text: string): string {
    return text;
}

/** Asks for nothing in particular. */
export interface BrokenRequest {
    /** Names {@link NoSuchThing}, which does not exist. */
    id: string;
}

/** Answers nothing in particular. */
export interface BrokenResponse {
    /** Names {@link helperOf}, a function. */
    id: string;
}

/** Three links that name nothing a document publishes (#1284). */
@ApiType(MCP)
@ApiPath('/broken')
export abstract class BrokenLinksApi {
    /**
     * Links the contract class itself, {@link BrokenLinksApi}.
     *
     * @summary Break a link
     * @returns Nothing useful.
     */
    @WpMcpTool('break_link')
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/break', READ, RPC)
    breakLink(_request: BrokenRequest): Promise<BrokenResponse> {
        throw new Error('contract only');
    }
}
