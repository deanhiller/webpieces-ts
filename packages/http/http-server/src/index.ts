// Express adapter (the only place express lifecycle lives) over the node-only WebpiecesRouter
export { WebpiecesExpress } from './WebpiecesExpress';
export { WebpiecesMiddleware } from './WebpiecesMiddleware';
export { WebpiecesRouteCreator } from './WebpiecesRouteCreator';
// InProcessApiClientFactory moved to node-only http-routing; re-export for back-compat
export { InProcessApiClientFactory } from '@webpieces/http-routing';
export { ContextFilter } from './filters/ContextFilter';
export { LogApiFilter } from './filters/LogApiFilter';
export { RecordingFilter } from './filters/RecordingFilter';
export { ServiceAuthFilter } from './filters/ServiceAuthFilter';

// Test-case recording (contract lives in @webpieces/core-util)
export { TestCaseRecorderImpl } from './recorder/TestCaseRecorderImpl';
export { SpecGenerator } from './recorder/SpecGenerator';
export { recordable } from './recorder/recordable';

// Context keys + registry (the global magic-context header system)
export { WebpiecesCoreHeaders } from './headers/WebpiecesCoreHeaders';
export { HeaderRegistry } from '@webpieces/core-util';

// Re-export from http-routing for backward compatibility
// (FilterDefinition re-exported for one-import adapter ergonomics)
export {
    RouteHandler,
    MethodMeta,
    RouteBuilderImpl,
    RouteHandlerWithMeta,
    FilterWithMeta,
    HttpFilter,
    FilterMatcher,
    FilterDefinition,
} from '@webpieces/http-routing';
// ExpressRouteHandler now lives in http-server (express adapter), not node-only http-routing
export { ExpressRouteHandler } from './WebpiecesMiddleware';
