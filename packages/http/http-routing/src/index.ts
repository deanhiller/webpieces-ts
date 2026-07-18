// Re-export API decorators from core-util for convenience
export {
    ApiPath,
    Endpoint,
    Authentication,
    AuthenticationConfig,
    Public,
    AuthJwt,
    AuthOidc,
    AuthSharedSecret,
    Rpc,
    PubSub,
    Queue,
    getApiPath,
    getEndpoints,
    getEndpointOptions,
    isFormPost,
    isApiPath,
    getAuthMeta,
    getAuthMode,
    assertEveryEndpointHasAuthMode,
    getApiKind,
    assertApiKind,
    assertPubSubConventions,
    getQueueName,
    AuthMeta,
    RouteMetadata,
    METADATA_KEYS,
    ValidateImplementation,
    // @DocumentDesign moved to core-util (design-root marker, browser + Node);
    // re-exported here for back-compat.
    DocumentDesign,
    isDocumentDesign,
} from '@webpieces/core-util';
export type { AuthMode, ApiKind, EndpointOptions } from '@webpieces/core-util';

// Server-side routing decorators and utilities
export {
    SourceFile,
    ROUTING_METADATA_KEYS,
} from './decorators';

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
export {
    Routes,
    RouteBuilder,
    RouteDefinition,
    FilterDefinition,
} from './WebAppMeta';

// The transport-neutral request type (defined in core-context; this is http-routing's
// public request — a transport adapter builds one and the chain reads it from RequestContext).
export { HttpRequest } from '@webpieces/core-context';

// Filter-chain primitives (absorbed from the former @webpieces/http-filters package)
export { Filter, WpResponse, Service } from './Filter';
export { FilterChain } from './FilterChain';
export { MethodMeta } from './MethodMeta';
export { RouteHandler } from './RouteHandler';

// LogApiFilter: the fixed OUTERMOST framework filter (auto-installed at 1,000,000 above
// AuthFilter). Exported for reference/testing only — apps must NOT install it themselves.
export { LogApiFilter } from './filters/LogApiFilter';

// RouteBuilderImpl (the route table + chain composer) is now INTERNAL — it is never
// handed to upper layers. The express layer consumes ApiFactory.apiClients() instead.

// Filter matching
export { FilterMatcher, HttpFilter } from './FilterMatcher';

// The app's server-surface declaration: DI binding modules + route groups + headers.
export { AppModules, RouteModule } from './AppModules';

// The public API-surface abstraction: declare routes/filters, get them back as ApiClient[].
export { ApiFactory } from './ApiFactory';
export { ApiClient, ApiClientProxy } from './ApiClient';

// Auth: the app-provided, container-bound pieces the framework AuthFilter injects.
//  - AuthConfig: shared-secret STATE (@AuthSharedSecret values).
//  - JwtHook / OidcHook: OPTIONAL verification mechanisms (bind only what you use).
//  - DefaultOidcVerifier: the built-in Google OIDC verifier used when no OidcHook is bound.
export { AuthConfig, AUTH_CONFIG, AuthValues, SharedSecrets } from './AuthConfig';
export { JwtHook, JWT_HOOK, OidcHook, OIDC_HOOK } from './AuthHooks';
export { DefaultOidcVerifier } from './DefaultOidcVerifier';
// DefaultJwtHook: batteries-included HS256 JwtHook — `new DefaultJwtHook(secret)` and go.
export { DefaultJwtHook } from './DefaultJwtHook';

// Above-boundary context setup shared by every transport adapter.

// Node-only router (the express-free heart: container + filter chain + in-process client)
export { WebpiecesRouter, WebpiecesRouterFactory, WebpiecesRouterOptions } from './WebpiecesRouter';

// The ONE transport-free startup sequence (headers → logging → router → routes) → ApiFactory.
// Reusable by any company/app and any framework adapter; a company wraps it with its own headers.
export { setupRuntime, RuntimeSetupOptions } from './setupRuntime';

// Server configuration
export { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';
