import 'reflect-metadata';
import { injectable } from 'inversify';
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    jwt,
    MCP,
    Mcp,
    MCP_INVOCATION_CONTEXT,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import { SearchRequest, SearchResponse } from './WpMcpServerTestFixtures';

/** One operation, two product names; all DTOs, auth and endpoint declarations remain single-source. */
@ApiPath('/renamed')
@ApiType(SVC_TO_SVC, MCP)
export abstract class RenamedApi {
    /**
     * List the caller's issues.
     * @summary List issues
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/list', READ, RPC)
    @WpMcpTool('bugfixer_list_issues', { profiles: [Mcp.DEFAULT] })
    @WpMcpTool('aideveloper_list_issues', { profiles: ['aideveloper'] })
    list(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract');
    }

    /**
     * Inspect protected issues with the same permission under either name.
     * @summary Inspect issues
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    @Endpoint(POST, '/inspect', READ, RPC)
    @WpMcpTool('aideveloper_inspect_issues', { profiles: ['aideveloper'] })
    @WpMcpTool('bugfixer_inspect_issues')
    inspect(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract');
    }
}

/** Records only observable endpoint results and the trusted invocation identity. */
@injectable()
export class RenamedController extends RenamedApi {
    static readonly invokedNames: string[] = [];
    override async list(request: SearchRequest): Promise<SearchResponse> {
        const invocation = RequestContext.getTrusted(MCP_INVOCATION_CONTEXT)!;
        RenamedController.invokedNames.push(invocation.toolName);
        const response = new SearchResponse();
        response.userId = invocation.subject;
        response.result = request.query;
        return response;
    }
    override async inspect(request: SearchRequest): Promise<SearchResponse> {
        return this.list(request);
    }
}
