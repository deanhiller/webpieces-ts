// Context management with AsyncLocalStorage
export { RequestContext } from './RequestContext';

// DI provider decorators (shared DI seam; http-routing re-exports for back-compat)
export { provideSingleton, provideSingletonAs, provideTransient } from './provide';

// Outbound-header machinery — MOVED to browser+node @webpieces/core-util so the
// isomorphic http-client can use ContextMgr without pulling in this Node-only
// (AsyncLocalStorage) package. Re-exported here for back-compat.
export { ContextMgr, RequestIdChainProcessor } from '@webpieces/core-util';
export { RequestContextReader } from './RequestContextReader';
