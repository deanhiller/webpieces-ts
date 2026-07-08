// Express adapter (the only place express lifecycle lives) over the node-only ApiFactory
export { WebpiecesExpressRouter } from './WebpiecesExpressRouter';
export { WebpiecesMiddleware } from './WebpiecesMiddleware';
export { LogApiFilter } from './filters/LogApiFilter';
export { RecordingFilter } from './filters/RecordingFilter';

// Test-case recording (contract lives in @webpieces/core-util)
export { TestCaseRecorderImpl } from './recorder/TestCaseRecorderImpl';
export { SpecGenerator } from './recorder/SpecGenerator';
export { recordable } from './recorder/recordable';

// Context keys + registry (the global magic-context header system)
export { WebpiecesCoreHeaders } from './headers/WebpiecesCoreHeaders';
export { HeaderRegistry } from '@webpieces/core-util';

// Re-export from http-routing for one-import adapter ergonomics
export {
    RouteHandler,
    MethodMeta,
    HttpFilter,
    FilterMatcher,
    FilterDefinition,
    ApiFactory,
    ApiClient,
    HttpRequest,
    AuthConfig,
    AuthValues,
    ContextValue,
} from '@webpieces/http-routing';
// ExpressRouteHandler now lives in http-server (express adapter), not node-only http-routing
export { ExpressRouteHandler } from './WebpiecesMiddleware';
