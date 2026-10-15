import {
    ApiPath,
    AuthorizationType,
    Endpoint,
    POST,
    READ,
    RPC,
    WpAuth,
    WpAuthorization,
    oidcSameProject,
    oidcSvcs,
} from '@webpieces/core-util';

export interface OidcScopesRequest {
    note: string;
}

/**
 * Both OIDC caller scopes on real decorators, so the extractor's descriptor-name mapping is pinned:
 * `oidcSameProject()` and `oidcSvcs([...])` are both documented as the one `oidc` credential kind.
 */
@ApiPath('/api/oidc-scopes')
export class OidcScopesApi {
    /** Any service account of the callee's own GCP project. */
    @Endpoint(POST, '/project', READ, RPC)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    project(request: OidcScopesRequest): Promise<void> {
        throw new Error('contract');
    }

    /** Exactly the listed service accounts, one of them in another project. */
    @Endpoint(POST, '/listed', READ, RPC)
    @WpAuth([oidcSvcs(['svc-a', 'partner@other-project.iam.gserviceaccount.com'])])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    listed(request: OidcScopesRequest): Promise<void> {
        throw new Error('contract');
    }

    /** This project's accounts OR the listed one: two caller scopes of one bearer credential. */
    @Endpoint(POST, '/paired', READ, RPC)
    @WpAuth([oidcSameProject(), oidcSvcs(['partner@other-project.iam.gserviceaccount.com'])])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    paired(request: OidcScopesRequest): Promise<void> {
        throw new Error('contract');
    }
}
