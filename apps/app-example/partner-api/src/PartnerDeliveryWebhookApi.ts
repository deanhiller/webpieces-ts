import {
    ApiPath,
    ApiType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WpAuthPublic,
} from '@webpieces/core-util';
import { OrderState } from './PartnerOrdersApi';

export interface OrderStateChangedEvent {
    /** The order whose state moved. */
    orderId: string;

    /** What it moved to. */
    state: OrderState;

    /** When the move happened, on our clock. @format date-time */
    at: string;
}

/**
 * The events this service SENDS to a partner's own endpoint.
 *
 * ## Why a webhook is declared in the manifest and never sniffed from a filename
 *
 * `openapi.manifest.json` marks this entry `"kind": "webhook"`, which is what moves it into the
 * document's top-level `webhooks:` block. A `*WebhookApi` NAME convention would have done the same
 * job with no file to review — and would then hide a partner-visible decision inside a rename, which
 * is the one edit nobody reviews for contract impact.
 *
 * ## What the generator does differently for these, and why
 *
 * - The event is keyed by its NAME with the `@ApiPath` base NOT prepended. The partner hosts the
 *   endpoint at whatever path they choose; there is no url of ours to publish.
 * - It carries `x-webpieces-webhook: true` and neither the trigger nor the auth extension, because
 *   neither is true of it.
 * - It contributes NOTHING to the derived security requirement. Publishing our api key as a guard on
 *   somebody else's server would be nonsense at best and an instruction to leak it at worst.
 * - The `void` return is documented as "return any 2xx to acknowledge".
 */
@ApiPath('/partner-webhooks')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export abstract class PartnerDeliveryWebhookApi {
    /**
     * Sent whenever an order's state changes.
     *
     * Deliveries are at-least-once and may arrive out of order; treat `state` as the state at `at`
     * and ignore an event older than one you have already applied.
     */
    @Endpoint(POST, '/order.state-changed', WRITE, RPC)
    @WpAuthPublic(
        'Never served by this process: this contract declares the payload we SEND to a partner endpoint, and the manifest is what selects it into the webhooks block.',
    )
    orderStateChanged(event: OrderStateChangedEvent): Promise<void> {
        throw new Error('Webhook contract: this service SENDS this event, it does not serve it');
    }
}
