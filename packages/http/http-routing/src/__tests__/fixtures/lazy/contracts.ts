import {
    ApiPath,
    Endpoint,
    POST,
    READ,
    RPC,
    WpAuthPublic,
    WpAuth,
    WpAuthorization,
    AuthorizationType,
    jwt,
} from '@webpieces/core-util';

export class AdminRequest {
    constructor(public readonly value: string) {}
}
export class AdminResponse {
    constructor(
        public readonly value: string,
        public readonly user: string | undefined,
        public readonly initializedAs: string | undefined,
        public readonly counter: number,
    ) {}
}
@ApiPath('/lazy-admin')
export abstract class DeferredAdminApi {
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    @Endpoint(POST, '/read', READ, RPC)
    read(_request: AdminRequest): Promise<AdminResponse> {
        throw new Error('contract');
    }
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    @Endpoint(POST, '/other', READ, RPC)
    other(_request: AdminRequest): Promise<AdminResponse> {
        throw new Error('contract');
    }
}
export class SharedCounter {
    private count = 0;
    next(): number {
        return ++this.count;
    }
}

@ApiPath('/critical')
export abstract class CriticalApi {
    @WpAuthPublic('Essential API remains available while optional code imports')
    @WpAuthorization({
        authType: AuthorizationType.ANONYMOUS,
        reason: 'Essential API remains available while optional code imports',
    })
    @Endpoint(POST, '/read', READ, RPC)
    read(_request: AdminRequest): Promise<number> {
        throw new Error('contract');
    }
}

@ApiPath('/other-lazy-admin')
export abstract class OtherDeferredAdminApi extends DeferredAdminApi {}
