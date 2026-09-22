/* eslint-disable */
/**
 * `@WpMin` on a STRING. A minimum on text is not something a renderer can emit, and dropping it
 * silently would publish a contract WEAKER than the one its author wrote down — so it fails the
 * build instead.
 */
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic, WpMin } from '@webpieces/core-util';

export class BadBounds {
    @WpMin(1)
    name!: string;
}

@ApiPath('/api/bad-bounds')
export class BadBoundsApi {
    @Endpoint(POST, '/bad', READ, RPC)
    @WpAuthPublic('Fixture only.')
    bad(request: BadBounds): Promise<void> {
        throw new Error('contract');
    }
}
