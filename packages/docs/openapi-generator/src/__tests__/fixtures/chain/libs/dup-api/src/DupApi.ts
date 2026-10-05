import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
/* eslint-disable */
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic } from '@webpieces/core-util';
import { DupDto as FirstDupDto } from './first/DupDto';
import { DupDto as SecondDupDto } from './second/DupDto';

/** Both. */
export interface BothDupsResponse {
    /** The first. */
    first: FirstDupDto;
    /** The second. */
    second: SecondDupDto;
}

/** Dup. */
@ApiPath('/dup')
export class DupApi {
    /** Reads both. */
    @Endpoint(POST, '/both', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    both(request: FirstDupDto): Promise<BothDupsResponse> {
        throw new Error('contract');
    }
}
