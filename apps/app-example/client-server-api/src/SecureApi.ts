import { WpAuthorization, AuthorizationType, WpAuth, jwt as jwtAuth, sharedSecret as sharedSecretAuth, oidc as oidcAuth } from '@webpieces/core-util';
import { ApiPath, Endpoint, POST, READ, RPC } from '@webpieces/core-util';

export class OrganizationAccessPolicy {
    inOrg!: true;
}

export interface SecureRequest {
    note?: string;
}

export interface SecureResponse {
    ok: boolean;
    userId?: string;
}

/**
 * SecureApi exercises independent authentication and authorization declarations:
 * userOp accepts jwt() and ALL_USERS; adminOp requires the admin role; orgOp delegates
 * organization access to CompanyAuthorizationHook; internalOp and serviceOp require
 * verified shared-secret/OIDC machine callers through SERVICE_ONLY.
 */
@ApiPath('/secure')
export abstract class SecureApi {
    /** Requires ANY logged-in user — a valid JWT, no particular role. The wide grant, named. */
    @Endpoint(POST, '/user', READ, RPC)
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    userOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method userOp() must be implemented by subclass');
    }

    /** Requires a user JWT carrying the 'admin' role. */
    @Endpoint(POST, '/admin', READ, RPC)
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin'] })
    adminOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method adminOp() must be implemented by subclass');
    }

    /** Custom app requirement: a logged-in user WHO belongs to an org — app field on the SAME decorator. */
    @Endpoint(POST, '/org', READ, RPC)
    @WpAuth([jwtAuth()])
    @WpAuthorization<OrganizationAccessPolicy>({ authType: AuthorizationType.CUSTOM, appPolicy: {inOrg: true} })
    orgOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method orgOp() must be implemented by subclass');
    }

    /** Requires the INTERNAL_API_SECRET shared-secret header. */
    @Endpoint(POST, '/internal', READ, RPC)
    @WpAuth([sharedSecretAuth('INTERNAL_API_SECRET')])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    internalOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method internalOp() must be implemented by subclass');
    }

    /** Requires a genuine Google OIDC token; @WpAuth([oidc()]) (no callers) trusts the edge for WHO (run.invoker IAM). */
    @Endpoint(POST, '/service', READ, RPC)
    @WpAuth([oidcAuth()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    serviceOp(request: SecureRequest): Promise<SecureResponse> {
        throw new Error('Method serviceOp() must be implemented by subclass');
    }
}
