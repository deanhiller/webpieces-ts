export { WebpiecesServer } from './WebpiecesServer';
export { WebpiecesFactory } from './WebpiecesFactory';
export { WebpiecesMiddleware } from './WebpiecesMiddleware';
export { ContextFilter } from './filters/ContextFilter';
export { LogApiFilter } from './filters/LogApiFilter';

// Platform Headers
export { WebpiecesModule } from './modules/WebpiecesModule';
export { WebpiecesCoreHeaders } from './headers/WebpiecesCoreHeaders';

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
