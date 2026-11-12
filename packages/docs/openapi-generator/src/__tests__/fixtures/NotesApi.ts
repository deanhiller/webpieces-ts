import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
/* eslint-disable */
/**
 * `@Endpoint`'s `additive` option in the OpenAPI documents (#1423): ADDITIVE writes next to the
 * defaulted shapes, so one run shows the description sentence and the MCP hint for each.
 */
import {
    ApiPath,
    ApiType,
    Endpoint,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthPublic,
    WpMcpTool,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';

/** A note to attach. */
export interface NoteRequest {
    /** The note's text. */
    text: string;
}

/** The note as stored. */
export interface NoteResponse {
    /** Its identifier. */
    id: string;
}

/** Notes on an order. */
@ApiPath('/notes')
@ApiType(SVC_TO_SVC, MCP)
export class NotesApi {
    /**
     * Adds a note; existing notes are never touched.
     *
     * @summary Add a note
     * @returns The stored note.
     */
    @Endpoint(POST, '/add', WRITE, RPC, { additive: true })
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('add_note')
    add(request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract');
    }

    /**
     * Saves a draft under a client-chosen key, creating it once.
     *
     * @summary Save a draft
     * @returns The stored draft.
     */
    @Endpoint(POST, '/draft', WRITE_IDEMPOTENT, RPC, { additive: true })
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('save_draft')
    draft(request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract');
    }

    /**
     * Replaces every note.
     *
     * @summary Replace notes
     * @returns The surviving note.
     */
    @Endpoint(POST, '/replace', WRITE, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('replace_notes')
    replace(request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract');
    }

    /**
     * Reads one note.
     *
     * @summary Read a note
     * @returns The note.
     */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('read_note')
    read(request: NoteRequest): Promise<NoteResponse> {
        throw new Error('contract');
    }
}
