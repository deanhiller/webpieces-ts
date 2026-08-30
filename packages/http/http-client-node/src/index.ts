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
 * const server2 = factory.createRpcClient(Server2Api, new ClientConfig('server2'));
 * const response = await server2.fetchValue(req);
 *
 * // a client whose destination arrives per call: ONE filter, and nothing else changes
 * const partner = factory.createRpcClient(PartnerWebhookApi, new ClientConfig('partner-webhooks'), [
 *     new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
 * ]);
 * ```
 */

export { ClientHttpFactory } from './ClientHttpFactory';
export { NodeProxyClient, NODE_PROXY_CLIENT_PROVIDER } from './NodeProxyClient';
export { ClientConfig } from './ClientConfig';

// Install this on the ONE client whose destination is data. Installing it IS the opt-in; a client
// without it ignores an ambient OVERRIDE_BASE_URL entirely.
export { ContextBaseUrlFilter } from './ContextBaseUrlFilter';
export { MissingRuntimeBaseUrlError } from './MissingRuntimeBaseUrlError';

// The OUTBOUND half of @AuthWebhook(name) — the mirror of http-routing's WebhookAuthCallback. Bind
// one, or every outbound @AuthWebhook call throws rather than delivering unsigned.
export { WebhookSignerCallback, SignableRequest, WEBHOOK_SIGNER_CALLBACK } from './WebhookSignerCallback';

// The SSRF policy a re-pointed URL is judged under, and the refusal it produces. Automatic, armed by
// the ACT of re-pointing; the ONLY way to relax it is naming SsrfTestingPolicy at a call site.
export { SsrfPolicy, SsrfTestingPolicy } from './SsrfPolicy';
export { SsrfGuardFilter } from './SsrfGuardFilter';
export { SsrfRefusedError } from './SsrfRefusedError';
export { OutboundAuthFilter } from './OutboundAuthFilter';
export { InternalAddressRules } from './InternalAddressRules';
export { AddressResolver, DnsAddressResolver } from './AddressResolver';

// The isomorphic engine, re-exported so a server app needs one import.
export { ProxyClient, ClientErrorTranslator, TranslatedFailure } from '@webpieces/http-client-core';
export { ClientRequest, ClientFilterDefinition } from '@webpieces/http-client-core';
export type { ClientFilter } from '@webpieces/http-client-core';
export type { ApiPrototype } from '@webpieces/http-client-core';
