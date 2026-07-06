export { WebpiecesServer } from './WebpiecesServer';
export { WebpiecesFactory } from './WebpiecesFactory';
export { WebpiecesMiddleware } from './WebpiecesMiddleware';
export { WebpiecesRouteCreator } from './WebpiecesRouteCreator';
export { InProcessApiClientFactory } from './InProcessApiClientFactory';
export { ContextFilter } from './filters/ContextFilter';
export { LogApiFilter } from './filters/LogApiFilter';
export { RecordingFilter } from './filters/RecordingFilter';

// Test-case recording (contract lives in @webpieces/core-util)
export { TestCaseRecorderImpl } from './recorder/TestCaseRecorderImpl';
export { SpecGenerator } from './recorder/SpecGenerator';
export { recordable } from './recorder/recordable';

// Platform Headers
export { WebpiecesModule } from './modules/WebpiecesModule';
export { WebpiecesCoreHeaders } from './headers/WebpiecesCoreHeaders';
export { HeaderRegistry } from '@webpieces/core-util';

// Re-export from http-routing for backward compatibility
// (FilterDefinition re-exported for one-import adapter ergonomics)
export {
    RouteHandler,
    ExpressRouteHandler,
    MethodMeta,
    RouteBuilderImpl,
    RouteHandlerWithMeta,
    FilterWithMeta,
    HttpFilter,
    FilterMatcher,
    FilterDefinition,
} from '@webpieces/http-routing';
