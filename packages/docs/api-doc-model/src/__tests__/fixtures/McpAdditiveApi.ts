import { WpAuthorization, AuthorizationType, WpAuth, jwt as jwtAuth } from '@webpieces/core-util';
import {
    ApiPath,
    ApiType,
    Endpoint,
    MCP,
    POST,
    PUT,
    RPC,
    WRITE,
    WRITE_IDEMPOTENT,
    WpMcpTool,
} from '@webpieces/core-util';

/** One note to write. */
export interface NoteRequest {
    /** The note's text. */
    text: string;
}

/** The note as stored. */
export interface NoteResponse {
    /** The note's id. */
    id: string;
}

/**
 * `@Endpoint`'s `additive` option (#1422): a write that only ever adds publishes
 * `destructiveHint: false`; the same write without it keeps MCP's safe default, `true`.
 */
@ApiPath('/notes')
@ApiType(MCP)
export abstract class McpAdditiveApi {
    /**
     * Adds a note to the order.
     *
     * @summary Add a note
     * @returns The stored note.
     */
    @Endpoint(POST, '/add', WRITE, RPC, { additive: true })
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @WpMcpTool('notes_add')
    add(_request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract only');
    }

    /**
     * Saves the draft under its own id, creating it the first time.
     *
     * @summary Save a draft
     * @returns The stored draft.
     */
    @Endpoint(PUT, '/draft', WRITE_IDEMPOTENT, RPC, { additive: true, openWorld: true })
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @WpMcpTool('notes_save_draft')
    saveDraft(_request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract only');
    }

    /**
     * Replaces every note on the order.
     *
     * @summary Replace notes
     * @returns The stored note.
     */
    @Endpoint(POST, '/replace', WRITE, RPC)
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @WpMcpTool('notes_replace')
    replace(_request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract only');
    }
}
