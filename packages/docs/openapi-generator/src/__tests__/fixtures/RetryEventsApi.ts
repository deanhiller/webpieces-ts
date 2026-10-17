/* eslint-disable */
/**
 * A WEBHOOK-ONLY contract feeding all three documents, including the MCP one (#1302). Every
 * declared operation is represented — READ, WRITE_IDEMPOTENT and WRITE — so no webhook can carry a
 * retry sentence by accident of which operation the decorator happened to require.
 */
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
    WRITE,
    WRITE_IDEMPOTENT,
    WpMcpTool,
} from '@webpieces/core-util';

/** The event a partner receives about a crate. */
export class CrateEvent {
    /** The crate the event is about. */
    crateId!: string;
}

/** Events about crates this service SENDS. */
@ApiPath('/crate-hooks')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class RetryEventsApi {
    /**
     * Sent when a crate is packed.
     *
     * @summary Crate packed
     */
    @Endpoint(POST, '/crate.packed', WRITE, RPC)
    @WpMcpTool('crate_packed')
    @WpAuthPublic('Never served here; this declares a payload we SEND to a partner endpoint.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here.' })
    cratePacked(event: CrateEvent): Promise<void> {
        throw new Error('contract');
    }

    /**
     * Sent when a crate is weighed.
     *
     * @summary Crate weighed
     */
    @Endpoint(POST, '/crate.weighed', WRITE_IDEMPOTENT, RPC)
    @WpAuthPublic('Never served here; this declares a payload we SEND to a partner endpoint.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here.' })
    crateWeighed(event: CrateEvent): Promise<void> {
        throw new Error('contract');
    }

    /**
     * Sent when a crate is inspected.
     *
     * @summary Crate inspected
     */
    @Endpoint(POST, '/crate.inspected', READ, RPC)
    @WpAuthPublic('Never served here; this declares a payload we SEND to a partner endpoint.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here.' })
    crateInspected(event: CrateEvent): Promise<void> {
        throw new Error('contract');
    }
}
