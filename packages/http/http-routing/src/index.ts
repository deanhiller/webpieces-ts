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
    RouteRequest,
} from './WebAppMeta';
