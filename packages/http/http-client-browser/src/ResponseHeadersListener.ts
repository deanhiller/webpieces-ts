import { RouteMetadata } from '@webpieces/core-util';

/**
 * The inbound seam an app implements to observe response headers on every RPC call — symmetric with
 * the outbound header propagation done by {@link MutableContextStore} / {@link ContextMgr}.
 *
 * Registered once on {@link ClientHttpBrowserFactory}, it is invoked by {@link BrowserProxyClient}
 * with the `fetch` Response `Headers` after each call, on BOTH the ok and error paths (so a
 * version — or any future — header is observed even on error responses), before the body is read.
 *
 * The driver is client↔server version matching: the server stamps `x-<org>-server-version` on every
 * response, and the browser reads it off each RPC response to detect that a newer server is deployed
 * than this bundle and prompt a reload.
 *
 * ```typescript
 * const factory = new ClientHttpBrowserFactory(store, {
 *     onResponseHeaders: (_route, headers) => {
 *         const v = headers.get('x-myorg-server-version');
 *         if (v) serverVersionBridge.set(v);
 *     },
 * });
 * ```
 *
 * This is BUSINESS LOGIC (a method), so it is an interface, not a data class.
 */
export interface ResponseHeadersListener {
    onResponseHeaders(route: RouteMetadata, headers: Headers): void;
}
