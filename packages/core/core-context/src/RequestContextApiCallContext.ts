import { ApiCallContext, ContextKey } from '@webpieces/core-util';
import { RequestContext } from './RequestContext';

/**
 * RequestContextApiCallContext - the SERVER (Node) implementation of the {@link ApiCallContext} seam,
 * backing it with the ambient {@link RequestContext} (AsyncLocalStorage). {@link LogApiCall} — which
 * lives in browser-safe core-util and cannot import RequestContext — stamps its `api` tag through this.
 *
 * Installed ONCE at server startup by `setupRuntime` (http-routing), beside `HeaderRegistry.configure`
 * and `LogManager.setFactory` — the one place that runs on every server, so BOTH inbound (LogApiFilter)
 * and outbound (clients) get the tag. A browser never runs setupRuntime, so it installs its own
 * module-global impl. This is the same "impl in the env-specific package, bound to a core-util seam at
 * startup" pattern as LogManager.setFactory + the winston/bunyan backends.
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
    set(contextKey: ContextKey, value: unknown): void {
        RequestContext.putHeader(contextKey, value);
    }

    remove(contextKey: ContextKey): void {
        RequestContext.removeHeader(contextKey);
    }
}
