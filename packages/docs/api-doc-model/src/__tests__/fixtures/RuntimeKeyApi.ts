import { WpAuthorization, AuthorizationType, WpAuth, apiKey as apiKeyAuth, AnyContextKey } from '@webpieces/core-util';
/* eslint-disable */
/**
 * A header credential whose ContextKey is only known at RUNTIME. The extractor must refuse and QUOTE
 * the expression it could not follow — never say the credential "declares no header name" (#1249).
 *
 * Its own file, because a hard failure takes the whole model down.
 */
import { ApiPath, Endpoint, POST, READ, RPC } from '@webpieces/core-util';
import { PartnerKeys } from './contract-constants';

export function keyAtRuntime(): AnyContextKey {
    return process.env['ORG'] ? PartnerKeys.ORG_ID : PartnerKeys.API_KEY;
}

export interface Empty {
    ok: boolean;
}

@ApiPath('/api/runtime-key')
export class RuntimeKeyApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuth([apiKeyAuth('partner', [{ in: 'header', key: keyAtRuntime() }])])
    @WpAuthorization({ authType: AuthorizationType.USERS_OR_SERVICES })
    go(request: Empty): Promise<void> {
        throw new Error('contract');
    }
}
