import { ApiPath, Endpoint, AuthJwt, Auth, AuthOidc, AuthSharedSecret } from '@webpieces/core-util';

export interface SecureRequest {
    note?: string;
}

export interface SecureResponse {
    ok: boolean;
    userId?: string;
}

/**
 * SecureApi - endpoints exercising each non-public AuthMode, for Authentication.spec.ts:
 *  - adminOp    → @AuthJwt('admin')      (role-gated user JWT)
 *  - internalOp → @AuthSharedSecret(...)  (internal shared-secret)
 *  - serviceOp  → @AuthOidc()             (service-to-service OIDC, caller = 'self')
 */
@ApiPath('/secure')
export abstract class SecureApi {
    /** Requires ANY logged-in user — a valid JWT with no particular role (@AuthJwt() = no roles). */
    @Endpoint('/user')
    @AuthJwt()
    userOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method userOp() must be implemented by subclass');
    }

    /** Requires a user JWT carrying the 'admin' role. */
    @Endpoint('/admin')
    @AuthJwt('admin')
    adminOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method adminOp() must be implemented by subclass');
    }

    /** Custom app requirement: a logged-in user WHO belongs to an org (@Auth({inOrg:true})). */
    @Endpoint('/org')
    @Auth({ inOrg: true })
    orgOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method orgOp() must be implemented by subclass');
    }

    /** Requires the INTERNAL_API_SECRET shared-secret header. */
    @Endpoint('/internal')
    @AuthSharedSecret('INTERNAL_API_SECRET')
    internalOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method internalOp() must be implemented by subclass');
    }

    /** Requires a Google OIDC token from this service's own SA (@AuthOidc() = 'self'). */
    @Endpoint('/service')
    @AuthOidc()
    serviceOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method serviceOp() must be implemented by subclass');
    }
}
