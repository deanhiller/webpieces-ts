/**
 * The example PARTNER-FACING contract, and the source `wp-openapi` reads.
 *
 * `generated/` holds the COMMITTED OpenAPI documents. `src/__tests__/openapi-golden.spec.ts`
 * regenerates them and diffs, so a decorator change that moves the document is a red test rather
 * than a silent republish.
 */
export { REQUEST_ID_HEADER } from './ResponseHeaders';
export type { ApiErrorResponse } from './ApiErrors';
export { PartnerOrdersApi } from './PartnerOrdersApi';
export type {
    AsapWindow,
    CancelOrderRequest,
    CancelOrderResponse,
    DeliveryWindow,
    FetchOrdersRequest,
    FetchOrdersResponse,
    Order,
    OrderState,
    ReindexRequest,
    ReindexResponse,
    ScheduledWindow,
} from './PartnerOrdersApi';
export { PartnerDeliveryWebhookApi } from './PartnerDeliveryWebhookApi';
export type { OrderStateChangedEvent } from './PartnerDeliveryWebhookApi';
