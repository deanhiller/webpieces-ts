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
export type { AuthMode, ApiKind } from '@webpieces/core-util';

// Server-side routing decorators and utilities
export {
    SourceFile,
    ROUTING_METADATA_KEYS,
} from './decorators';

// DI provider decorators moved to core-context; re-exported here for back-compat
export { provideSingleton, provideSingletonAs, provideTransient } from '@webpieces/core-context';
// Framework-only DI registry (packages/** framework classes use these; see frameworkProvide.ts)
export {
    provideFrameworkSingleton,
    provideFrameworkSingletonAs,
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

// RouteBuilderImpl (the route table + chain composer) is now INTERNAL — it is never
// handed to upper layers. The express layer consumes ApiFactory.apiClients() instead.

// Filter matching
export { FilterMatcher, HttpFilter } from './FilterMatcher';

// The public API-surface abstraction: declare routes/filters, get them back as ApiClient[].
export { ApiFactory } from './ApiFactory';
export { ApiClient } from './ApiClient';

// Auth: the app-provided, container-bound verifiers the framework AuthFilter injects.
export { AuthConfig, Principal } from './AuthConfig';

// Above-boundary context setup shared by every transport adapter.
export { fillContext } from './fillContext';

// Node-only router (the express-free heart: container + filter chain + in-process client)
export { WebpiecesRouter, WebpiecesRouterFactory, WebpiecesRouterOptions } from './WebpiecesRouter';

// Context readers (Node.js only) moved to core-context; re-exported for back-compat
export { RequestContextReader } from '@webpieces/core-context';

// Server configuration
export { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';
