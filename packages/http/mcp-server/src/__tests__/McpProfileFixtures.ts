import { injectable } from 'inversify';
import {
    ApiPath,
    ApiType,
    Endpoint,
    POST,
    READ,
    RPC,
    MCP,
    SVC_TO_SVC,
    Mcp,
    WpAuth,
    jwt,
    WpAuthorization,
    AuthorizationType,
    WpMcpTool,
    WpMcpToolMetadata,
    getWpMcpTools,
    McpToolCatalogFile,
    McpToolDefinition,
    mcpHintsForOperation,
} from '@webpieces/core-util';
import { McpToolCatalog } from '../McpToolCatalog';
import { SEARCH_API_CATALOG, SearchRequest, SearchResponse } from './WpMcpServerTestFixtures';

@ApiPath('/profile-spec')
@ApiType(SVC_TO_SVC, MCP)
export abstract class ProfileApi {
    /** Learner-only tool. */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/learner', READ, RPC)
    @WpMcpTool('learner', 'Learner')
    learner(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract');
    }

    /** Admin-only tool. */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    @Endpoint(POST, '/admin', READ, RPC)
    @WpMcpTool('admin', 'Admin', { profiles: ['admin'] })
    admin(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract');
    }

    /** Shared tool that still requires admin authority. */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    @Endpoint(POST, '/shared', READ, RPC)
    @WpMcpTool('shared', 'Shared', { profiles: [Mcp.DEFAULT, 'admin'] })
    shared(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract');
    }

    /** A third independently selectable group. */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/course', READ, RPC)
    @WpMcpTool('course', 'Course', { profiles: ['course-authoring'] })
    course(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract');
    }
}

@injectable()
export class ProfileController extends ProfileApi {
    calls: string[] = [];
    override async learner(request: SearchRequest): Promise<SearchResponse> {
        this.calls.push('learner');
        return new SearchResponseValue(request.query);
    }
    override async admin(request: SearchRequest): Promise<SearchResponse> {
        this.calls.push('admin');
        return new SearchResponseValue(request.query);
    }
    override async shared(request: SearchRequest): Promise<SearchResponse> {
        this.calls.push('shared');
        return new SearchResponseValue(request.query);
    }
    override async course(request: SearchRequest): Promise<SearchResponse> {
        this.calls.push('course');
        return new SearchResponseValue(request.query);
    }
}

class SearchResponseValue extends SearchResponse {
    constructor(query: string) {
        super();
        this.userId = 'profile';
        this.result = query;
    }
}

const schema = SEARCH_API_CATALOG.file.tools[0];
export const PROFILE_CATALOG = new McpToolCatalog(
    new McpToolCatalogFile(
        'ProfileApi',
        getWpMcpTools(ProfileApi).map(
            (tool: WpMcpToolMetadata) =>
                new McpToolDefinition(
                    tool.name,
                    tool.title,
                    tool.methodName,
                    'Profile fixture',
                    mcpHintsForOperation(READ, false),
                    schema.inputSchema,
                    schema.outputSchema,
                    tool.profiles,
                ),
        ),
    ),
    '(profile fixture)',
);
