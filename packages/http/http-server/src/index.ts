// Express adapter (the only place express lifecycle lives) over the node-only ApiFactory
export { WebpiecesExpressRouter } from './WebpiecesExpressRouter';
export { WebpiecesMiddleware } from './WebpiecesMiddleware';
// How routes read the body bytes: stream (default) or a host's pre-consumed req.rawBody (issue #937).
// Chosen via WebpiecesExpressRouter.setBodyReader(...) before bindExpress(app).
export { RequestBodyReader } from './body/RequestBodyReader';
export { StreamBodyReader } from './body/StreamBodyReader';
export { PreConsumedBodyReader } from './body/PreConsumedBodyReader';
// LogApiFilter is now a FIXED framework filter auto-installed by WebpiecesRouter (outermost, at
// priority 1,000,000, above AuthFilter). Apps must NOT install it themselves — it is no longer
// exported here. Remove any `router.addFilter(new FilterDefinition(1800, LogApiFilter, '*'))`.
export { RecordingFilter } from './filters/RecordingFilter';

// The webpieces DEFAULT error response, exported as a DELEGABLE object: it returns the same
// HttpResponseDto an app's ErrorTranslators.toWire returns, so an app wraps it ("webpieces' answer,
// plus one header") rather than copying its status-to-message table.
export { ApiErrorHttpMapper } from './ApiErrorHttpMapper';
export { ExpressResponseWriter } from './ExpressResponseWriter';
// How ApiEndUserError is answered: 'gui' (266, default) or 'edge' (its edgeHttpStatus, else 400).
// Chosen via WebpiecesExpressRouter.setEndUserStatus(...) before bindExpress(app) (issue #948).
export type { EndUserStatus } from './ApiErrorHttpMapper';

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
    AuthenticatedCaller,
    SharedSecrets,
} from '@webpieces/http-routing';
// ExpressRouteHandler now lives in http-server (express adapter), not node-only http-routing
export { ExpressRouteHandler } from './WebpiecesMiddleware';
