/* eslint-disable */
/**
 * A WEBHOOK contract: the events we send to a partner's own server. Selected into the document's
 * top-level `webhooks:` block by the manifest, never by this file's name.
 */
import {
    ApiPath,
    ApiType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    RPC,
    SVC_TO_SVC,
    WpAuthPublic,
    WRITE,
} from '@webpieces/core-util';

export interface WidgetMadeEvent {
    /** The widget that was made. */
    widgetId: string;
}

/** Events this service SENDS. */
@ApiPath('/hooks')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class EventsApi {
    /** Sent whenever a widget is made. */
    @Endpoint(POST, '/widget.made', WRITE, RPC)
    @WpAuthPublic('Never served here; this declares a payload we SEND to a partner endpoint.')
    widgetMade(event: WidgetMadeEvent): Promise<void> {
        throw new Error('contract');
    }
}
