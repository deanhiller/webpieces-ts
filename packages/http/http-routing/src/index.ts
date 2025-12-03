// Re-export API decorators from http-api for convenience
export {
    ApiInterface,
    Get,
    Post,
    Put,
    Delete,
    Patch,
    Path,
    getRoutes,
    isApiInterface,
    RouteMetadata,
    METADATA_KEYS,
    ValidateImplementation,
} from '@webpieces/http-api';

// Server-side routing decorators and utilities
export {
    Controller,
    isController,
    provideSingleton,
    provideTransient,
    ROUTING_METADATA_KEYS,
} from './decorators';

export { RESTApiRoutes, ClassType } from './RESTApiRoutes';

// Core routing types (moved from core-meta)
export {
    WebAppMeta,
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
