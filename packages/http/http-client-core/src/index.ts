/**
 * @webpieces/http-client-core
 *
 * The ISOMORPHIC core of the webpieces HTTP client — everything that reads an API contract's
 * decorators and turns a method call into an HTTP request, with no opinion about where the
 * magic context comes from or whether a DI container exists.
 *
 * You almost certainly want one of its two environment packages instead:
 * - Server:  @webpieces/http-client-node    (inversify-wired, reads RequestContext, mints OIDC)
 * - Browser: @webpieces/http-client-browser (no DI — React or Angular, app-managed context store)
 *
 * Architecture:
 * ```
 * http-api (defines the contract)
 *    ^
 *    +-- http-routing (server: contract -> handlers)
 *    +-- http-client-core (contract -> HTTP requests)   <- YOU ARE HERE
 *          +-- http-client-node     (RequestContext + Secrets + OIDC + inversify factory)
 *          +-- http-client-browser  (app-held store + plain factory, no DI)
 * ```
 *
 * There is no context/credential/recording seam here at all: ProxyClient is ABSTRACT and asks its
 * subclass for the base URL, the context headers, the log map, the outbound credential, and the
 * recorder. Nothing server-only (RequestContext, Secrets, mintIdToken, TestCaseRecorder) can reach
 * a browser bundle, and nothing browser-only (a ContextReader store) reaches a server.
 */

export { ProxyClient } from './ProxyClient';
export { RequestOutcome } from './RequestOutcome';
export type { ApiPrototype } from './ApiPrototype';
export { buildClientProxy } from './buildClientProxy';
export { ClientErrorTranslator } from './ClientErrorTranslator';
