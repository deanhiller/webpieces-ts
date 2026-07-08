import { ContextKey } from '@webpieces/core-util';

/**
 * HttpRequest - webpieces' TRANSPORT-NEUTRAL inbound request.
 *
 * This is @webpieces/http-routing's own request type (http-routing re-exports it), NOT
 * express's `req`. Each transport adapter (the express adapter in @webpieces/http-server, or
 * any other TypeScript web framework) builds an HttpRequest from its native request and hands
 * it to the router. Filters and the auth layer read it via `RequestContext.getRequest()`
 * instead of touching express — which is what lets the SAME filter chain run over HTTP and
 * in-process (tests build an HttpRequest carrying their credential).
 *
 * It lives in core-context (alongside RequestContext, which stores it in AsyncLocalStorage)
 * to avoid a core-context → http-routing cycle; it is a pure data holder (no express, no DI).
 */
export class HttpRequest {
    constructor(
        public readonly method: string,
        public readonly path: string,
        /** Header name (lowercased) -> values (HTTP allows multiple values per name). */
        public readonly headers: Map<string, string[]>,
    ) {}

    /** First value of a header, looked up by ContextKey.httpHeader (or a raw lowercased name). */
    getHeader(key: ContextKey | string): string | undefined {
        const values = this.getHeaderValues(key);
        return values && values.length > 0 ? values[0] : undefined;
    }

    /** All values of a header. */
    getHeaderValues(key: ContextKey | string): string[] | undefined {
        const name = (typeof key === 'string' ? key : key.httpHeader ?? key.name).toLowerCase();
        return this.headers.get(name);
    }
}
