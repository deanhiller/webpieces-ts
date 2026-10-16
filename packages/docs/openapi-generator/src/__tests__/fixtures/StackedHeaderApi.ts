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

/**
 * THE PROMOTIONS SECTION of a management API — a FILE HEADER written as JSDoc (#1286, repro 1).
 *
 * It is not the enum's description, but TypeScript attaches it to the enum below anyway.
 */
/**
 * Every state a promotion can be in.
 */
export enum PromotionStateDto {
    ACTIVE = 'active',
    ENDED = 'ended',
}

/** Which promotions to read. */
export class ListPromotionsRequest {
    /** Only promotions in this state. */
    state!: PromotionStateDto;
}

/** The promotions that matched. */
export class ListPromotionsResponse {
    /** How many matched. */
    count!: number;
}

/** Promotions. */
@ApiPath('/promotions')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class StackedHeaderApi {
    /** Lists promotions. */
    @Endpoint(POST, '/list', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    list(request: ListPromotionsRequest): Promise<ListPromotionsResponse> {
        throw new Error('contract');
    }
}
