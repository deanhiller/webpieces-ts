import { ContextKey, AnyContextKey } from '@webpieces/core-util';
import { RawRequest } from './RawRequest';

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
        /**
         * The verbatim bytes + absolute url, present ONLY on an `@Endpoint(..., { rawBody: true })`
         * route (see {@link RawRequest}). Absent everywhere else, and absent is the SAFE state:
         * `@AuthWebhook` has nothing to verify without it and 401s rather than waving the call
         * through. A spec driving a webhook route in-process supplies one here, the same way a spec
         * today supplies an `authorization` header.
         */
        public readonly raw?: RawRequest,
    ) {}

    /** First value of a header, looked up by ContextKey.httpHeader (or a raw lowercased name). */
    getHeader(key: AnyContextKey | string): string | undefined {
        const values = this.getHeaderValues(key);
        return values && values.length > 0 ? values[0] : undefined;
    }

    /** All values of a header. */
    getHeaderValues(key: AnyContextKey | string): string[] | undefined {
        const name = (typeof key === 'string' ? key : key.httpHeader ?? key.name).toLowerCase();
        return this.headers.get(name);
    }
}
