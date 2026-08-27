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
 * const server2 = factory.createRpcClient(
 *     Server2Api,
 *     new ClientConfig('server2', new DeployedServiceHost()),
 *     [],   // this client's outbound filters
 * );
 * const response = await server2.fetchValue(req);
 * ```
 */

export { ClientHttpFactory } from './ClientHttpFactory';
export { NodeProxyClient, NODE_PROXY_CLIENT_PROVIDER } from './NodeProxyClient';
export { ClientConfig } from './ClientConfig';

// WHERE a client's requests go. Naming one is required on every ClientConfig — see HostPolicy.
export { HostPolicy, DeployedServiceHost, RuntimeHostFromContext, RuntimeHostFromContextAllowingInternalAddresses } from './HostPolicy';

// The SSRF policy a runtime host is judged under, and the refusal it produces. On by default; the
// ONLY way to relax it is naming RuntimeHostFromContextAllowingInternalAddresses at the call site.
export { SsrfPolicy } from './SsrfPolicy';
export { SsrfGuardFilter } from './SsrfGuardFilter';
export { SsrfRefusedError } from './SsrfRefusedError';
export { InternalAddressRules } from './InternalAddressRules';
export { AddressResolver, DnsAddressResolver } from './AddressResolver';

// The built-in outbound filter that carries a per-call destination from the RequestContext into the
// send path, and the two framework priorities an app orders its own filters against.
export { ContextBaseUrlOverrideFilter, BASE_URL_OVERRIDE_PRIORITY, SSRF_GUARD_PRIORITY } from './ContextBaseUrlOverrideFilter';

// The isomorphic engine, re-exported so a server app needs one import.
export { ProxyClient, ClientErrorTranslator, TranslatedFailure } from '@webpieces/http-client-core';
export { ClientRequest, ClientFilterDefinition } from '@webpieces/http-client-core';
export type { ClientFilter } from '@webpieces/http-client-core';
export type { ApiPrototype } from '@webpieces/http-client-core';
