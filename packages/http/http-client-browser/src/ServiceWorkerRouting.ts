/**
 * Whether a browser RPC may be intercepted by the page's service worker (#1293).
 *
 * WHY the default BYPASSES: Angular's service worker (ngsw) intercepts EVERY fetch, cross-origin RPC
 * included, and when the network rejects it does not pass the rejection on — `Driver.safeFetch`
 * answers with a synthetic `504 Gateway Timeout` instead. The client then cannot tell "the request
 * never reached a server" (`ApiConnectionError`, safe to retry a READ) from a real gateway 504, and
 * a user is shown "Gateway Timeout — report a bug" for a dropped connection. With the bypass, the
 * fetch rejects natively and a 504 always means a real gateway timeout.
 */
export enum ServiceWorkerRouting {
    /**
     * Append the `ngsw-bypass=true` QUERY parameter to every RPC url. A query parameter rather than
     * the `ngsw-bypass` header, because a custom header is not CORS-safelisted and would need every
     * server's `Access-Control-Allow-Headers` changed. webpieces servers bind query parameters by
     * name, so the extra key is ignored.
     */
    BYPASS = 'BYPASS',
    /**
     * Leave the url alone, so a service worker may serve or cache the call (e.g. an ngsw
     * `dataGroups` entry). ngsw's synthetic 504 is still recognised and re-typed as
     * `ApiConnectionError` (see `ServiceWorkerSyntheticResponse`).
     */
    ALLOW = 'ALLOW',
}
