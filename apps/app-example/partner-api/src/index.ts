/**
 * The example PARTNER-FACING contract, and the source `wp-openapi` reads.
 *
 * Its generated documents are build output and are never committed (`.claude/rules/api-docs.md`).
 * `src/__tests__/goldens/` holds the generator's EXPECTED output for this contract, as test
 * fixtures: `src/__tests__/openapi-golden.spec.ts` regenerates and diffs against them, so a
 * generator change that moves what it emits is a red test rather than a silent republish.
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
