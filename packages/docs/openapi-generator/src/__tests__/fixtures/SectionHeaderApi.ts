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

/*
 * THE COUPONS SECTION — a section header written the right way, as a plain block comment. It is
 * never anybody's description.
 */
/**
 * Every state a coupon can be in.
 */
export enum CouponStateDto {
    LIVE = 'live',
    SPENT = 'spent',
}

/** Which coupons to read. */
export class ListCouponsRequest {
    /** Only coupons in this state. */
    state!: CouponStateDto;
}

/** The coupons that matched. */
export class ListCouponsResponse {
    /** How many matched. */
    count!: number;
}

/** Coupons. */
@ApiPath('/coupons')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class SectionHeaderApi {
    /**
     * Lists coupons.
     *
     * @returns How many coupons matched.
     */
    @Endpoint(POST, '/list', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    list(request: ListCouponsRequest): Promise<ListCouponsResponse> {
        throw new Error('contract');
    }
}
