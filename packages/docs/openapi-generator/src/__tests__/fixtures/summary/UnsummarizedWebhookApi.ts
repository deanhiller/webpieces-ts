/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, RPC, WpAuthorization, WpAuthPublic, WRITE } from '@webpieces/core-util';

/** The event a partner receives when a crate ships. */
export class CrateShippedEvent {
    /** The crate that shipped. */
    crateId!: string;
}

/** The events we send about crates. */
@ApiPath('/crate-hooks')
export class UnsummarizedWebhookApi {
    /** Sent when a crate ships; a webhook needs a summary line exactly like a route. */
    @Endpoint(POST, '/crate.shipped', WRITE, RPC)
    @WpAuthPublic('Never served here.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Never served here.' })
    crateShipped(event: CrateShippedEvent): Promise<void> {
        throw new Error('contract');
    }
}
