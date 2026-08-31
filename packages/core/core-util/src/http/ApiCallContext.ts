import { AnyUntrustedContextKey } from '../ContextKey';

/**
 * ApiCallContext - the tiny seam that lets {@link LogApiCallImpl} (browser-safe, core-util) stamp a
 * ContextKey (the `api` tag) into the ambient request context WITHOUT importing it.
 *
 * WHY a seam instead of a direct call: the ambient context is `RequestContext` in
 * `@webpieces/core-context`, which is built on Node `async_hooks` (AsyncLocalStorage). core-util —
 * and `ProxyClient`, which runs in a BROWSER bundle — must never import that (it would be a circular
 * dependency, and it would drag Node vocabulary into a browser build). So core-util owns only this
 * interface, and each environment-specific package CONSTRUCTS its own impl and hands it to
 * {@link LogApiCallImpl}'s constructor:
 * - Node server inbound: `LogApiFilter` (http-routing) → `RequestContextApiCallContext`.
 * - Node client outbound: `NodeProxyClient` (http-client-node) and `TaskProxyClient`
 *   (cloudtasks-client) → `RequestContextApiCallContext`.
 * - Browser: `BrowserProxyClient` (http-client-browser) → `BrowserApiCallContext`.
 *
 * There is deliberately NO process-global holder and no startup install: the context is a REQUIRED
 * constructor argument, so "nobody set it up" is a compile error rather than a runtime throw on the
 * first real call. That is what lets a plain NestJS/Express host use `@webpieces/http-client-node` or
 * `@webpieces/cloudtasks-client` with no webpieces STARTUP INSTALL — it only has to run the call
 * inside a `RequestContext.run(...)` scope, which such a host already opens per request. (The other
 * process-globals those clients read — HeaderRegistry, LogManager, a ClientRegistry mapping or
 * deriver — are unchanged by this and still apply.)
 *
 * Per CLAUDE.md this is behavior, hence an interface; the impls are ordinary classes.
 */
export interface ApiCallContext {
    /**
     * True when there is a context to stamp into (a live Node RequestContext scope; a browser is always
     * active). {@link LogApiCallImpl} throws if this is false — an api call with nowhere to tag is a bug.
     */
    isActive(): boolean;

    /**
     * Stamp one UNTRUSTED ContextKey → value into the ambient context. Untrusted by type on purpose:
     * this seam is reachable from browser-side client code, so if it accepted a trusted key it would
     * be a side door for forging a proven identity. The one key it actually stamps
     * ({@link WebpiecesCoreHeaders.API_CALL_INFO}) is a log tag, which is untrusted by nature.
     * The logger reads it back off the context
     * (server: RequestContext.buildStructuredLogFields; browser: its own store) during the log emit.
     */
    // webpieces-disable no-any-unknown -- a context value is heterogeneous (the api struct here; strings elsewhere)
    set(contextKey: AnyUntrustedContextKey, value: unknown): void;

    /**
     * Clear one ContextKey. {@link LogApiCallImpl} calls set → log → remove as one SYNCHRONOUS span, so the
     * tag is never held across `await`. That is what makes a single browser global safe: single-threaded,
     * nothing can interleave between set and remove, so a concurrent call can never clobber the slot.
     */
    remove(contextKey: AnyUntrustedContextKey): void;
}
