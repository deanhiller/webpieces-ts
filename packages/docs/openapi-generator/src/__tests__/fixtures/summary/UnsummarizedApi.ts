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

/** Which crate to address. */
export class CrateRequest {
    /** The crate's identifier. */
    crateId!: string;
}

/** One crate. */
export class CrateResponse {
    /** What the crate holds. */
    contents!: string;
}

/** Crates, three of whose methods have no usable summary line. */
@ApiPath('/crates')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class UnsummarizedApi {
    /**
     * Opens one crate; it has no summary tag at all, and it is an MCP tool.
     *
     * @returns The crate's contents.
     */
    @Endpoint(POST, '/open', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('open_crate')
    open(request: CrateRequest): Promise<CrateResponse> {
        throw new Error('contract');
    }

    /**
     * Seals one crate; its summary runs onto a second line, which a heading cannot carry.
     *
     * @summary Seal a crate
     * and then keep talking on a second line
     * @returns The crate after sealing.
     */
    @Endpoint(POST, '/seal', READ, RPC, { hidden: true })
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    seal(request: CrateRequest): Promise<CrateResponse> {
        throw new Error('contract');
    }

    /**
     * Weighs one crate; its summary is a paragraph, far over the limit.
     *
     * @summary Weigh one crate on the loading-dock scale and report the gross weight including the pallet it rests on
     * @returns The crate with its weight.
     */
    @Endpoint(POST, '/weigh', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    weigh(request: CrateRequest): Promise<CrateResponse> {
        throw new Error('contract');
    }

    /**
     * Counts crates; its summary is fine, so it is NOT named.
     *
     * @summary Count crates
     * @returns The crate holding the count.
     */
    @Endpoint(POST, '/count', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    count(request: CrateRequest): Promise<CrateResponse> {
        throw new Error('contract');
    }
}
