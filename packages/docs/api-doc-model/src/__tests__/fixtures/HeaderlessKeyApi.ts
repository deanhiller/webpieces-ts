import { WpAuthorization, AuthorizationType, WpAuth, apiKey as apiKeyAuth } from '@webpieces/core-util';
/* eslint-disable */
/**
 * A header credential naming a CONTEXT-ONLY key — `PartnerKeys.IN_PROCESS` has no httpHeader. The
 * extractor must refuse, naming the key: there is no header name to publish (#1249).
 *
 * Its own file, because a hard failure takes the whole model down.
 */
import { ApiPath, Endpoint, POST, READ, RPC } from '@webpieces/core-util';
import { PartnerKeys } from './contract-constants';

export interface Empty {
    ok: boolean;
}

@ApiPath('/api/headerless')
export class HeaderlessKeyApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuth([apiKeyAuth('partner', [{ in: 'header', key: PartnerKeys.IN_PROCESS }])])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    go(request: Empty): Promise<void> {
        throw new Error('contract');
    }
}
