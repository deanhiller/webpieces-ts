export { WebpiecesServer } from './WebpiecesServer';
export { WebpiecesFactory } from './WebpiecesFactory';
export { WebpiecesMiddleware } from './WebpiecesMiddleware';
export { ContextFilter } from './filters/ContextFilter';
export { JsonFilter } from './filters/JsonFilter';
export { LogApiFilter } from './filters/LogApiFilter';

// Platform Headers
export { WebpiecesModule } from './modules/WebpiecesModule';
export { WebpiecesCoreHeaders } from './headers/WebpiecesCoreHeaders';

// Express implementations of Router interfaces
export { ExpressRouterRequest } from './express/ExpressRouterRequest';
export { ExpressRouterResponse } from './express/ExpressRouterResponse';

// Re-export from http-routing for backward compatibility
export {
    RouteHandler,
    ExpressRouteHandler,
    MethodMeta,
    RouteBuilderImpl,
    RouteHandlerWithMeta,
    FilterWithMeta,
    HttpFilter,
    FilterMatcher,
} from '@webpieces/http-routing';
