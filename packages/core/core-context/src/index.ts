// Context management with AsyncLocalStorage
export { RequestContext } from './RequestContext';
// SERVER impl of the core-util ApiCallContext seam, bound to RequestContext. Importing it here runs
// its install() side effect, so LogApiCall (core-util, browser-safe) stamps the real RequestContext on
// a Node server without importing it. A browser never loads core-context → keeps the no-op.
export { RequestContextApiCallContext } from './RequestContextApiCallContext';
// Transport-neutral request stored in the context (http-routing's request type; re-exported there)
export { HttpRequest } from './HttpRequest';

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
