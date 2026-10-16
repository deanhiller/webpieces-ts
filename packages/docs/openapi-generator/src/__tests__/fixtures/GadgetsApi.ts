/* eslint-disable */
/**
 * A second contract with a method named `list` — the same name as {@link WidgetsApi.list}.
 *
 * Under `"operationIds": "contract_method"` the two publish as `WidgetsApi_list` and `GadgetsApi_list`;
 * under `"operationIds": "method"` both would publish as `list`, which the generator refuses (#1270).
 */
import { ApiPath, ApiType, AuthorizationType, Endpoint, POST, READ, RPC, SVC_TO_SVC, WpAuthPublic, WpAuthorization } from '@webpieces/core-util';

/** Which gadgets to list. */
export interface ListGadgetsRequest {
    prefix: string;
}

/** The gadgets that matched. */
export interface ListGadgetsResponse {
    names: string[];
}

/** Gadgets. */
@ApiPath('/gadgets')
@ApiType(SVC_TO_SVC)
export class GadgetsApi {
    /**
     * Lists gadgets.
     *
     * @returns The names of the matching gadgets.
     */
    @Endpoint(POST, '/list', READ, RPC)
    @WpAuthPublic('A fixture; nothing here to protect.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'A fixture; nothing here to protect.' })
    list(request: ListGadgetsRequest): Promise<ListGadgetsResponse> {
        throw new Error('contract');
    }
}
