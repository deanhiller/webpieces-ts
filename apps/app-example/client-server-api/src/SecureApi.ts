import { ApiPath, Endpoint, AuthJwt, AuthOidc, AuthSharedSecret } from '@webpieces/core-util';

export interface SecureRequest {
    note?: string;
}

export interface SecureResponse {
    ok: boolean;
    userId?: string;
}

/**
 * SecureApi - endpoints exercising each non-public AuthMode, for Authentication.spec.ts:
 *  - userOp     → @AuthJwt({allRolesAllowed: true})  (any authenticated user — the NAMED wide grant)
 *  - adminOp    → @AuthJwt({roles: ['admin']})       (role-gated user JWT)
 *  - orgOp      → @AuthJwt({..., inOrg: true})       (app-defined authZ, enforced by authorizeJwt)
 *  - internalOp → @AuthSharedSecret(...)             (internal shared-secret)
 *  - serviceOp  → @AuthOidc()                        (service-to-service OIDC, trust-the-edge)
 */
@ApiPath('/secure')
export abstract class SecureApi {
    /** Requires ANY logged-in user — a valid JWT, no particular role. The wide grant, named. */
    @Endpoint('/user', 'rpc')
    @AuthJwt({ allRolesAllowed: true })
    userOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method userOp() must be implemented by subclass');
    }

    /** Requires a user JWT carrying the 'admin' role. */
    @Endpoint('/admin', 'rpc')
    @AuthJwt({ roles: ['admin'] })
    adminOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method adminOp() must be implemented by subclass');
    }

    /** Custom app requirement: a logged-in user WHO belongs to an org — app field on the SAME decorator. */
    @Endpoint('/org', 'rpc')
    @AuthJwt({ allRolesAllowed: true, inOrg: true })
    orgOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method orgOp() must be implemented by subclass');
    }

    /** Requires the INTERNAL_API_SECRET shared-secret header. */
    @Endpoint('/internal', 'rpc')
    @AuthSharedSecret('INTERNAL_API_SECRET')
    internalOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method internalOp() must be implemented by subclass');
    }

    /** Requires a genuine Google OIDC token; @AuthOidc() (no callers) trusts the edge for WHO (run.invoker IAM). */
    @Endpoint('/service', 'rpc')
    @AuthOidc()
    serviceOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method serviceOp() must be implemented by subclass');
    }
}
