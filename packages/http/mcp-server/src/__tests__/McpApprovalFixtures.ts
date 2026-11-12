import 'reflect-metadata';
import { injectable } from 'inversify';
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    ContextKey,
    Endpoint,
    EndpointOperation,
    getWpMcpTools,
    jwt,
    MCP,
    McpToolCatalogFile,
    McpToolDefinition,
    mcpHintsForOperation,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WebpiecesCoreHeaders,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    WpMcpToolMetadata,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';
import { RequestContext } from '@webpieces/core-context';
import {
    McpApprovalDecision,
    McpApprovalHook,
    McpRemoteToolCall,
} from '../McpApproval';
import { McpToolCatalog } from '../McpToolCatalog';
import { SEARCH_API_CATALOG, SearchRequest, SearchResponse } from './WpMcpServerTestFixtures';

/** One READ, one WRITE and one WRITE_IDEMPOTENT tool, for the approval hook's feature test (#1422). */
@ApiPath('/notes')
@ApiType(SVC_TO_SVC, MCP)
export abstract class NotesApi {
    /**
     * List the caller's notes.
     *
     * @summary List notes
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/list', READ, RPC)
    @WpMcpTool('notes_list')
    list(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    /**
     * Add a note.
     *
     * @summary Add note
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/add', WRITE, RPC, { additive: true })
    @WpMcpTool('notes_add')
    add(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }

    /**
     * Replace a note under its own id.
     *
     * @summary Put note
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/put', WRITE_IDEMPOTENT, RPC)
    @WpMcpTool('notes_put')
    put(_request: SearchRequest): Promise<SearchResponse> {
        throw new Error('contract only');
    }
}

@injectable()
export class NotesController extends NotesApi {
    static readonly calls: string[] = [];

    override async list(request: SearchRequest): Promise<SearchResponse> {
        return this.answer('list', request);
    }

    override async add(request: SearchRequest): Promise<SearchResponse> {
        return this.answer('add', request);
    }

    override async put(request: SearchRequest): Promise<SearchResponse> {
        return this.answer('put', request);
    }

    private answer(method: string, request: SearchRequest): SearchResponse {
        NotesController.calls.push(method);
        const response = new SearchResponse();
        response.userId = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID) ?? 'missing';
        response.result = request.query;
        return response;
    }
}

/** What each method's `@Endpoint` declares, as the build's catalog would compute its hints from. */
class NotesEffect {
    constructor(
        public readonly operation: EndpointOperation,
        public readonly additive: boolean,
    ) {}
}

const EFFECTS = new Map<string, NotesEffect>([
    ['list', new NotesEffect(READ, false)],
    ['add', new NotesEffect(WRITE, true)],
    ['put', new NotesEffect(WRITE_IDEMPOTENT, false)],
]);

const SCHEMA = SEARCH_API_CATALOG.file.tools[0];
export const NOTES_CATALOG = new McpToolCatalog(
    new McpToolCatalogFile(
        'NotesApi',
        getWpMcpTools(NotesApi).map((tool: WpMcpToolMetadata) => {
            const effect = EFFECTS.get(tool.methodName)!;
            return new McpToolDefinition(
                tool.name,
                `Notes ${tool.name}`,
                tool.methodName,
                'Notes fixture',
                mcpHintsForOperation(effect.operation, false, effect.additive),
                SCHEMA.inputSchema,
                SCHEMA.outputSchema,
                tool.profiles,
            );
        }),
    ),
    '(notes fixture)',
);

/**
 * A host-defined, NON-transferable context key (no HTTP header): the host's own code sets it around
 * the one `callTool` a person approved, and the hook reads it.
 */
export const HOST_APPROVED_TOOL = ContextKey.untrusted<string>('hostApprovedTool');

/** One question the hook was asked, with what it could read from the caller's RequestContext. */
export class AskedApproval {
    constructor(
        public readonly call: McpRemoteToolCall,
        public readonly approvedTool: string | undefined,
    ) {}
}

/** The host's hook, scripted by the test: records every call it is asked about, then decides. */
export class ScriptedApprovalHook implements McpApprovalHook {
    readonly asked: AskedApproval[] = [];
    decide: (call: McpRemoteToolCall) => McpApprovalDecision = () => McpApprovalDecision.allow();

    async check(call: McpRemoteToolCall): Promise<McpApprovalDecision> {
        this.asked.push(new AskedApproval(call, RequestContext.getUntrusted(HOST_APPROVED_TOOL)));
        return this.decide(call);
    }
}
