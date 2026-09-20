import { RouteMetadata } from '@webpieces/core-util';
import { RequestOutcome } from '@webpieces/http-client-core';

/**
 * The inbound seam an app implements to observe the FULL lifecycle of every RPC call — symmetric
 * with the outbound header propagation done by {@link MutableContextStore} / {@link ContextMgr}.
 * Registered once on {@link ClientHttpBrowserFactory}; invoked by {@link BrowserProxyClient} around
 * each call.
 *
 * Replaces the older header-only ResponseHeadersListener. `onRequestEnd`'s `outcome.headers` carries
 * the same Response Headers (after settlement, on both ok and error), and it adds the
 * two signals the header-only seam could not give: a START marker, and success-or-error.
 *
 * The driver is a browser app that must drive ONE progress bar across N requests per user action,
 * AND detect that a newer server is deployed than this bundle (the server stamps
 * `x-<org>-server-version` on every response) — reloading only at a safe moment, so a half-filled
 * form is never blown away. It needs, per RPC: bar on, bar off, the outcome, and the headers.
 *
 * `onRequestStart` and `onRequestEnd` are PAIRED: every start is followed by exactly one end, on
 * every path (2xx, HTTP error, network reject), so a counter driven off them cannot leak.
 *
 * `route.background` is the endpoint's own declaration that it is plumbing the user did not ask for
 * — a log shipper, a heartbeat, a telemetry flush (`@Endpoint(..., { background: true })`). It is not
 * progress, so a bar driven off these callbacks should skip it, and so should any app-level RPC
 * instrumentation whose own lines would otherwise become the next batch's payload. webpieces already
 * emits no `[API-client-*]` line for such a route; this is the app's half of the same fact, read from
 * the ROUTE rather than matched on a path string.
 *
 * ```typescript
 * class RpcLifecycleListener implements RequestLifecycleListener {
 *     onRequestStart(route: RouteMetadata): void {
 *         if (route.background) return;
 *         progressBar.noteRequestStart();
 *     }
 *     onRequestEnd(route: RouteMetadata, outcome: RequestOutcome): void {
 *         serverVersionBridge.set(outcome.headers?.get('x-myorg-server-version'));
 *         if (route.background) return;
 *         progressBar.noteRequestEnd(!outcome.ok);
 *     }
 * }
 * const factory = new ClientHttpBrowserFactory(store, new RpcLifecycleListener());
 * ```
 *
 * This is BUSINESS LOGIC (methods), so it is an interface, not a data class — unlike the
 * {@link RequestOutcome} it is handed.
 */
export interface RequestLifecycleListener {
    /** Before fetch, once per RPC. */
    onRequestStart(route: RouteMetadata): void;

    /** Once, after the call settles, on every path (success, HTTP error, network reject). */
    onRequestEnd(route: RouteMetadata, outcome: RequestOutcome): void;
}
