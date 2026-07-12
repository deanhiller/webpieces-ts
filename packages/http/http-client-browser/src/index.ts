/**
 * @webpieces/http-client-browser
 *
 * The BROWSER HTTP client. Reads an API contract's decorators and generates type-safe HTTP
 * clients from it — the same contract the server implements.
 *
 * DI-free on purpose: this may be bundled by React or Angular, so it ships no inversify and no
 * @webpieces/core-context (which is AsyncLocalStorage-backed and Node-only). Browsers have no
 * ambient request scope, so the app holds a {@link MutableContextStore} and sets context values
 * as they become known; every outbound call then transfers them as headers.
 *
 * Usage:
 * ```typescript
 * import { ClientHttpBrowserFactory, ClientConfig, MutableContextStore } from '@webpieces/http-client-browser';
 *
 * HeaderRegistry.configure(CompanyHeaders.getAllHeaders(), true);
 * const store = new MutableContextStore();
 * const factory = new ClientHttpBrowserFactory(store);
 *
 * const client = factory.createRpcClient(SaveApi, new ClientConfig('save-svc'));
 * const response = await client.save({ query: 'test' });
 * ```
 *
 * The server twin is @webpieces/http-client-node.
 */

export { ClientHttpBrowserFactory } from './ClientHttpBrowserFactory';
export { BrowserProxyClient } from './BrowserProxyClient';
export { ClientConfig } from './ClientConfig';
export { MutableContextStore } from './MutableContextStore';

// The isomorphic engine, re-exported so a browser app needs one import.
export { ProxyClient, ClientErrorTranslator } from '@webpieces/http-client-core';
export type { ApiPrototype } from '@webpieces/http-client-core';

// ContextMgr is the BROWSER's outbound-header propagation. This is the only package that may use
// it; the server reads RequestContext directly (RequestContextHeaders in @webpieces/core-context).
export { ContextMgr } from '@webpieces/core-util';

// Re-export the context-key contract from core-util for convenience (browser one-import)
export {
    ContextReader,
    ContextKey,
    HeaderRegistry,
    ClientRegistry,
    WebpiecesCoreHeaders,
} from '@webpieces/core-util';

// Re-export API decorators for convenience (same as http-routing does)
export {
    ApiPath,
    Endpoint,
    Authentication,
    AuthenticationConfig,
    Public,
    AuthJwt,
    AuthOidc,
    AuthSharedSecret,
    Rpc,
    PubSub,
    Queue,
    ValidateImplementation,
} from '@webpieces/core-util';
