/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
    WpMcpTool,
} from '@webpieces/core-util';

/** Which shelf to read. */
export class ShelfRequest {
    /** The shelf's identifier. */
    shelfId!: string;
}

/** One shelf and what is on it. */
export class ShelfResponse {
    /** The titles of the books on the shelf, left to right. */
    titles!: string[];
}

/** Shelves of books: every endpoint carries a valid summary line (#1296). */
@ApiPath('/shelves')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class ShelvesApi {
    /**
     * Reads one shelf, left to right.
     *
     * Empty shelves are returned with no titles rather than refused.
     *
     * @summary Read a shelf
     * @returns The shelf's titles, left to right.
     */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('read_shelf')
    read(request: ShelfRequest): Promise<ShelfResponse> {
        throw new Error('contract');
    }
}
