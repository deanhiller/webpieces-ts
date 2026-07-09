/**
 * @webpieces/http-client-node
 *
 * The SERVER-side HTTP client. Reads an API contract's decorators and generates type-safe HTTP
 * clients from it — the same contract the callee's controller implements.
 *
 * Node-only, so unlike @webpieces/http-client-browser it is fully inversify-wired and reads the
 * magic context straight out of the AsyncLocalStorage-backed RequestContext. There is no
 * ContextReader indirection, because a server has exactly one right answer, and a call made
 * OUTSIDE `RequestContext.run(...)` throws instead of silently dropping the trace.
 *
 * Usage:
 * ```typescript
 * import { ClientHttpFactory, ClientConfig } from '@webpieces/http-client-node';
 *
 * // inject the factory, then one client per contract
 * const server2 = factory.createClient(Server2Api, new ClientConfig('server2'));
 * const response = await server2.fetchValue(req);
 * ```
 */

export { ClientHttpFactory } from './ClientHttpFactory';
export { NodeProxyClient, NODE_PROXY_CLIENT_PROVIDER } from './NodeProxyClient';
export { ClientConfig } from './ClientConfig';

// The isomorphic engine, re-exported so a server app needs one import.
export { ProxyClient, ClientErrorTranslator } from '@webpieces/http-client-core';
export type { ApiPrototype } from '@webpieces/http-client-core';
