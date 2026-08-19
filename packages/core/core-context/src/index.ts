// Context management with AsyncLocalStorage
export { RequestContext } from './RequestContext';
// The OPAQUE snapshot type that copyContext() produces and restoreContext()/runWithContext() accept.
//
// `export type`, NOT `export` — deliberately. Consumers need to NAME it (a field, a queue entry, a
// parameter) and nothing more. A VALUE export would hand them the class object, and with it the static
// `capture(...)`, whose capability token a cast can supply even though this barrel never exports the
// token's type: `CapturedContext.capture(null as never, new Map([['userId','victim']]))` would compile
// and forge a proven identity — the exact hole this whole change closes. A type-only export removes the
// class object from the package surface, so there is no factory to reach and copyContext() really is
// the only producer. (ContextCaptureAuthority is not exported here in any form.)
export type { CapturedContext } from './CapturedContext';
// The narrowed snapshot — what withTrusted() / withoutTrusted() produce and what
// runWithContext()/restoreContext() accept. A bare CapturedContext is NOT accepted by either, so every
// call site states whether the proven identity travels with the work (`grep -rn withTrusted`) or is
// deliberately dropped (`grep -rn withoutTrusted`). Type-only for the same reason as above: with no
// class object on the surface there is no `of(...)` factory to reach, cast or not.
export type { RestorableContext } from './CapturedContext';
// SERVER impl of the core-util ApiCallContext seam, bound to RequestContext. Importing it here runs
// its install() side effect, so LogApiCall (core-util, browser-safe) stamps the real RequestContext on
// a Node server without importing it. A browser never loads core-context → keeps the no-op.
export { RequestContextApiCallContext } from './RequestContextApiCallContext';
// Transport-neutral request stored in the context (http-routing's request type; re-exported there)
export { HttpRequest, RawHttpRequest } from './HttpRequest';
// The verbatim bytes + absolute url a webhook SIGNATURE is computed over ({ rawBody: true } routes).
export { RawRequest } from './RawRequest';

// DI provider decorators (shared DI seam; http-routing re-exports for back-compat)
export { provideSingletonDefaultForApi } from './provide';
// Guice-style Provider<T> — lazy singleton OR fresh-per-get, decided by T's binding scope.
export { Provider } from './provide';
// Framework-only DI registry (packages/** use these; keeps framework classes out of a
// client's buildProviderModule() global scan). See frameworkProvide.ts.
export {
    provideFrameworkSingleton,
    provideFrameworkSingletonDefaultForApi,
    provideFrameworkTransient,
    bindFrameworkProvider,
    buildFrameworkModule,
} from './frameworkProvide';
export type { FrameworkScope } from './frameworkProvide';

// Outbound headers for a SERVER: reads RequestContext directly, fails fast outside
// RequestContext.run(...). Server-side clients (http-client-node, cloudtasks-client) and
// http-routing use THIS.
//
// ContextMgr is deliberately NOT re-exported. It is the browser's answer (an app-held store),
// and only @webpieces/http-client-browser may name it — importing it here would let a node
// package reach for a ContextReader it has no use for.
export { RequestContextHeaders } from './RequestContextHeaders';
// The browser store's server counterpart, still used by the logging packages + http-server filters.
export { RequestContextReader } from './RequestContextReader';
export { PendingWireTrust, PendingTrustedValue } from './PendingWireTrust';
