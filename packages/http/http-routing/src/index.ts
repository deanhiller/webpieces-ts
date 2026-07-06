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
} from '@webpieces/core-util';
export type { AuthMode, ApiKind } from '@webpieces/core-util';

// Server-side routing decorators and utilities
export {
    DocumentDesign,
    isDocumentDesign,
    SourceFile,
    ROUTING_METADATA_KEYS,
} from './decorators';

// DI provider decorators moved to core-context; re-exported here for back-compat
export { provideSingleton, provideSingletonAs, provideTransient } from '@webpieces/core-context';

export { ApiRoutingFactory, ClassType } from './ApiRoutingFactory';

// Core routing types (moved from core-meta)
export {
    WebAppMeta,
    WEBAPP_META_TOKEN,
    Routes,
    RouteBuilder,
    RouteDefinition,
    FilterDefinition,
} from './WebAppMeta';

// Method metadata (moved to http-filters) re-exported for back-compat; route handler
export { MethodMeta } from '@webpieces/http-filters';
export { RouteHandler } from './RouteHandler';

// Route builder implementation
export {
    RouteBuilderImpl,
    RouteHandlerWithMeta,
    FilterWithMeta,
    ExpressRouteHandler,
} from './RouteBuilderImpl';

// Filter matching
export { FilterMatcher, HttpFilter } from './FilterMatcher';

// Context readers (Node.js only) moved to core-context; re-exported for back-compat
export { RequestContextReader } from '@webpieces/core-context';

// Server configuration
export { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';
