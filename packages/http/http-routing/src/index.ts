// Re-export API decorators from core-util for convenience
export {
    ApiPath,
    Endpoint,
    PathParam,
    QueryParam,
    WpAuthPublic,
    WpAuth, WpLocalOnly, isLocalOnly, jwt, oidc, sharedSecret, webhook, apiKey,
    WpAuthorization, AuthorizationType, getAuthorization,
    Rpc,
    PubSub,
    Queue,
    getApiPath,
    getEndpoints,
    getEndpointOptions,
    getEndpointHttpMethod,
    getEndpointOperation,
    getHttpParameterDeclarations,
    isFormPost,
    isRawBody,
    isApiPath,
    getAuthMeta,
    assertEveryEndpointHasAuthMode,
    getApiKind,
    assertApiKind,
    assertPubSubConventions,
    getQueueName,
    AuthMeta,
    RouteMetadata,
    RouteMetadataFactory,
    HttpContractMapper,
    METADATA_KEYS,
    ValidateImplementation,
    GET,
    POST,
    READ,
    WRITE_IDEMPOTENT,
    WRITE,
    RPC,
    CLOUDTASKS,
    CRON,
    EXTERNAL,
    // @DocumentDesign moved to core-util (design-root marker, browser + Node);
    // re-exported here for back-compat.
    DocumentDesign,
    isDocumentDesign,
} from '@webpieces/core-util';
export type {
    AuthMode,
    ApiKind,
    HttpMethod,
    EndpointOperation,
    EndpointKind,
    EndpointOptions,
    EndpointResponseType,
} from '@webpieces/core-util';

// Server-side routing decorators and utilities
export { SourceFile, ROUTING_METADATA_KEYS } from './decorators';

// DI provider decorators moved to core-context; re-exported here for back-compat
export { provideSingletonDefaultForApi } from '@webpieces/core-context';
// Framework-only DI registry (packages/** framework classes use these; see frameworkProvide.ts)
export {
    provideFrameworkSingleton,
    provideFrameworkSingletonDefaultForApi,
    buildFrameworkModule,
} from '@webpieces/core-context';

export { ApiRoutingFactory, ClassType } from './ApiRoutingFactory';

// Core routing types
export { Routes, RouteBuilder, RouteDefinition, FilterDefinition } from './WebAppMeta';

// The transport-neutral request type (defined in core-context; this is http-routing's
// public request — a transport adapter builds one and the chain reads it from RequestContext).
export { HttpRequest, RawHttpRequest, RawRequest } from '@webpieces/core-context';

// The INBOUND chain's response type. `Filter`, `Service` and `FilterChain` are NOT re-exported
// here: they moved to @webpieces/core-util so the outbound client chain is the SAME abstraction
// rather than a second spelling of it. Import them from '@webpieces/core-util'.
export { WpResponse } from './WpResponse';
export { AuthenticatedCallerContext } from './AuthenticatedCallerContext';
export { InvocationAuthentication } from './InvocationAuthentication';
export { MethodMeta } from './MethodMeta';
export { RouteHandler } from './RouteHandler';

// LogApiFilter: the fixed OUTERMOST framework filter (auto-installed at 1,000,000 above
// AuthFilter). Exported for reference/testing only — apps must NOT install it themselves.
export { LogApiFilter } from './filters/LogApiFilter';

// RouteBuilderImpl (the route table + chain composer) is now INTERNAL — it is never
// handed to upper layers. The express layer consumes ApiFactory.apiClients() instead.

// Filter matching
export { FilterMatcher, HttpFilter } from './FilterMatcher';

// The app's server-surface declaration: DI bind modules + route groups + headers.
export type { Wiring, AppWiring, BindModule, RouteModule } from './Wiring';
export { NodeWiringModules } from './Wiring';
// The Node binder every BindModule.configure receives.
export type { Binder } from './Binder';
export { ContainerBinder, ClientBindOptions, PubSubBindOptions } from './Binder';

// The public API-surface abstraction: declare routes/filters, get them back as ApiClient[].
export { ApiFactory } from './ApiFactory';
export { ApiClient, ApiClientProxy } from './ApiClient';

// Auth: the app-provided, container-bound pieces the framework AuthFilter injects.
//  - AuthConfig: shared-secret STATE (sharedSecret(...) values).
//  - JwtHook / OidcHook / WebhookAuthCallback / ApiKeyHook: OPTIONAL verification mechanisms
//    (bind only what you use; unbound means the matching endpoints 401, never open).
//  - DefaultOidcVerifier: the built-in Google OIDC verifier used when no OidcHook is bound.
export {
    AuthConfig,
    AUTH_CONFIG,
    AuthenticatedCaller,
    AuthenticatedMachineIdentity,
    AUTHENTICATED_CALLER_KEY,
    SharedSecrets,
} from './AuthConfig';
export {
    JwtHook,
    MintedJwt,
    JWT_HOOK,
    OidcHook,
    OIDC_HOOK,
    WebhookAuthCallback,
    WEBHOOK_AUTH_CALLBACK,
    ApiKeyHook,
    API_KEY_HOOK,
} from './AuthHooks';
export { DefaultOidcVerifier } from './DefaultOidcVerifier';
// DefaultJwtHook: batteries-included HS256 JwtHook — `new DefaultJwtHook(secret)` and go.
export { DefaultJwtHook, DefaultJwtMintRequest } from './DefaultJwtHook';

// Above-boundary context setup shared by every transport adapter.

// Node-only router (the express-free heart: container + filter chain + in-process client)
export { WebpiecesRouter, WebpiecesRouterFactory, WebpiecesRouterOptions } from './WebpiecesRouter';

// The ONE transport-free startup sequence (headers → logging → router → routes) → ApiFactory.
// Reusable by any company/app and any framework adapter; a company wraps it with its own headers.
export { setupRuntime, RuntimeSetupOptions } from './setupRuntime';

// Server configuration
export { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';


export { AuthorizationHook, AuthorizationService, CanonicalUserRoles, AUTHORIZATION_HOOK, VERIFIED_MACHINE_CALLER, VerifiedMachineCaller } from './AuthorizationHook';
export { AuthorizedApiDocument } from './AuthorizedApiDocument';
export type { ApiDocumentObject, ApiDocumentValue } from './AuthorizedApiDocument';

export { WiringPolicy } from '@webpieces/http-client-core';
