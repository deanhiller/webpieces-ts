import { ApiCallContext, AnyUntrustedContextKey } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * RequestContextApiCallContext - the SERVER (Node) implementation of the {@link ApiCallContext} seam,
 * backing it with the ambient {@link RequestContext} (AsyncLocalStorage). {@link LogApiCallImpl} — which
 * lives in browser-safe core-util and cannot import RequestContext — stamps its `api` tag through this.
 *
 * CONSTRUCTED, never installed: `LogApiFilter` (http-routing, inbound), `NodeProxyClient`
 * (http-client-node, outbound http) and `TaskProxyClient` (cloudtasks-client, outbound enqueue) each
 * build one and pass it to their own {@link LogApiCallImpl}. Every one of those packages is node-only
 * and already depends on core-context, so none of them needs a startup hook — which is what lets a
 * plain NestJS/Express host use a webpieces client with no webpieces STARTUP INSTALL. What it DOES
 * still need is an open `RequestContext.run(...)` scope, because {@link isActive} is false outside one
 * and LogApiCall throws on an inactive context. A browser never loads core-context; it builds a
 * `BrowserApiCallContext` instead.
 *
 * WRITE-ONLY: the logging backends read the stamped key back off RequestContext
 * (`buildStructuredLogFields`) on every record, so this seam only needs to set it.
 */
export class RequestContextApiCallContext implements ApiCallContext {
    /** A live request scope is required to stamp; LogApiCall checks this and throws when false. */
    isActive(): boolean {
        return RequestContext.isActive();
    }

    // webpieces-disable no-any-unknown -- a context value is heterogeneous (the api struct here; strings elsewhere)
    set(contextKey: AnyUntrustedContextKey, value: unknown): void {
        RequestContext.putUntrusted(contextKey, value);
    }

    remove(contextKey: AnyUntrustedContextKey): void {
        RequestContext.removeKey(contextKey);
    }
}
