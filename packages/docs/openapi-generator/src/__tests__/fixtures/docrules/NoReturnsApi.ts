/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, READ, RPC, WpAuthorization, WpAuthPublic } from '@webpieces/core-util';

/** Which item to read. */
export class ReadItemRequest {
    /** The item's identifier. */
    itemId!: string;
}

/** The item. */
export class ReadItemResponse {
    /** Its name. */
    name!: string;
}

/** Items, two of whose methods forgot their returns tag. */
@ApiPath('/items')
export class NoReturnsApi {
    /** Reads one item; it has no returns tag, so it is refused. */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    read(request: ReadItemRequest): Promise<ReadItemResponse> {
        throw new Error('contract');
    }

    /** Reads it again; also refused, in the SAME run. */
    @Endpoint(POST, '/reread', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    reread(request: ReadItemRequest): Promise<ReadItemResponse> {
        throw new Error('contract');
    }

    /** Touches one item. `void`: there is no body for a returns tag to describe, so none is required. */
    @Endpoint(POST, '/touch', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    touch(request: ReadItemRequest): Promise<void> {
        throw new Error('contract');
    }
}
