// Re-export API decorators from http-api for convenience
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
} from '@webpieces/http-api';
export type { AuthMode, ApiKind } from '@webpieces/http-api';

// Server-side routing decorators and utilities
export {
    Controller,
    isController,
    NotController,
    isNotController,
    ApiImplementation,
    isApiImplementation,
    provideSingleton,
    provideSingletonAs,
    provideTransient,
    ROUTING_METADATA_KEYS,
} from './decorators';

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

// Method metadata and route handler
export { MethodMeta } from './MethodMeta';
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

// Context readers (Node.js only)
export { RequestContextReader } from './RequestContextReader';

// Server configuration
export { WebpiecesConfig, WEBPIECES_CONFIG_TOKEN } from './WebpiecesConfig';
