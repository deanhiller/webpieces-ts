// Context management with AsyncLocalStorage
export { RequestContext } from './RequestContext';

// DI provider decorators (shared DI seam; http-routing re-exports for back-compat)
export { provideSingleton, provideSingletonAs, provideTransient } from './provide';

// Outbound-header machinery (request-context -> outbound HTTP headers)
export { ContextMgr } from './ContextMgr';
export { RequestIdChainProcessor } from './RequestIdChainProcessor';
export { RequestContextReader } from './RequestContextReader';
