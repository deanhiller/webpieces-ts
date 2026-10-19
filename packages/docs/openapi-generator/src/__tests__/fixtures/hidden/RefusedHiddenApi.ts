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

/** A request with a REQUIRED hidden field. */
export class RequiredHiddenRequest {
    /** Shown. */
    shown!: string;

    /**
     * Required AND hidden: the customer document would omit a property the server insists on.
     * @hidden
     */
    secret!: string;
}

/** Every field hidden: the customer schema would be empty. */
export class AllHiddenResponse {
    /**
     * One.
     * @hidden
     */
    one?: string;

    /**
     * Two.
     * @hidden
     */
    two?: number;
}

/** Refused hidden fields (#1246). */
@ApiPath('/refused')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class RefusedHiddenApi {
    /**
     * Refused.
     *
     * @summary Refused
     * @returns Nothing published.
     */
    @Endpoint(POST, '/refused', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    refused(request: RequiredHiddenRequest): Promise<AllHiddenResponse> {
        throw new Error('contract');
    }
}
