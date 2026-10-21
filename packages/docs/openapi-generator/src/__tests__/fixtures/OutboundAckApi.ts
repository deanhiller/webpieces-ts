import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
/* eslint-disable */
/**
 * An EXTERNAL_OUTBOUND webhook (#1348): the partner's server answers, so a `void` return is
 * documented as "any 2xx acknowledges", never as our server's `204 No Content`.
 */
import { ApiPath, Endpoint, EXTERNAL_OUTBOUND, POST, WpAuthPublic, WRITE } from '@webpieces/core-util';

/** The event a partner receives when a gadget ships. */
export interface GadgetShippedEvent {
    /** The gadget that shipped. */
    gadgetId: string;
}

/** Events this service SENDS to a partner. */
@ApiPath('/hooks')
export class OutboundAckApi {
    /**
     * Sent whenever a gadget ships.
     *
     * @summary Gadget shipped
     */
    @Endpoint(POST, '/gadget.shipped', WRITE, EXTERNAL_OUTBOUND)
    @WpAuthPublic('Never served here; this declares a payload we SEND to a partner endpoint.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here; this declares a payload we SEND to a partner endpoint.' })
    gadgetShipped(event: GadgetShippedEvent): Promise<void> {
        throw new Error('contract');
    }
}
