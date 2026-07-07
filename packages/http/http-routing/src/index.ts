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
    FilterTier,
} from './WebAppMeta';

// Method metadata (moved to http-filters) re-exported for back-compat; route handler
export { MethodMeta } from '@webpieces/http-filters';
export { RouteHandler } from './RouteHandler';

// Route builder implementation
export {
    RouteBuilderImpl,
    RouteHandlerWithMeta,
    FilterWithMeta,
} from './RouteBuilderImpl';

// Filter matching
export { FilterMatcher, HttpFilter } from './FilterMatcher';

// In-process API client builder (node-only; the primary test/in-process path)
export { InProcessApiClientFactory } from './InProcessApiClientFactory';

// Node-only router (the express-free heart: container + filter chain + in-process client)
export { WebpiecesRouter, WebpiecesRouterFactory, WebpiecesRouterOptions } from './WebpiecesRouter';

// Context readers (Node.js only) moved to core-context; re-exported for back-compat
export { RequestContextReader } from '@webpieces/core-context';

// Server configuration
export { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';
