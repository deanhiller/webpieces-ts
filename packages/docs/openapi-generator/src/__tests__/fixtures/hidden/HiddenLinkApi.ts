/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
} from '@webpieces/core-util';

/** Asks for a quote. Compare {@link QuoteRequest.discountCode}. */
export class QuoteRequest {
    /** The item. Never sent with {@link discountCode}. */
    itemId!: string;

    /**
     * A discount code.
     * @hidden
     */
    discountCode?: string;
}

/** The quote. */
export class QuoteResponse {
    /** The price, in cents. */
    cents!: number;
}

/** Links to a hidden field from published prose (#1246). */
@ApiPath('/quotes')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class HiddenLinkApi {
    /**
     * Quotes an item.
     *
     * @summary Quote an item
     * @returns The quote.
     */
    @Endpoint(POST, '/quote', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    quote(request: QuoteRequest): Promise<QuoteResponse> {
        throw new Error('contract');
    }
}
