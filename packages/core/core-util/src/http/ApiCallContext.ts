import { ContextKey } from '../ContextKey';

/**
 * ApiCallContext - the tiny seam that lets {@link LogApiCall} (browser-safe, core-util) stamp a
 * ContextKey (the `api` tag) into the ambient request context WITHOUT importing it.
 *
 * WHY a seam instead of a direct call: the ambient context is `RequestContext` in
 * `@webpieces/core-context`, which is built on Node `async_hooks` (AsyncLocalStorage). core-util —
 * and `ProxyClient`, which runs in a BROWSER bundle — must never import that (it would be a circular
 * dependency, and it would drag Node vocabulary into a browser build). So core-util owns only this
 * interface + a global holder; each environment installs its own impl at startup:
 * - Node server: `setupRuntime` installs a RequestContext-backed impl.
 * - Browser: `ClientHttpBrowserFactory` installs a module-global impl.
 *
 * If NEITHER installs one, {@link ApiCallContextHolder.get} THROWS (loud misconfiguration, in the
 * webpieces spirit) — see its message. There is deliberately no silent no-op default.
 *
 * This mirrors the existing global-singleton-configured-at-startup pattern (LogManager,
 * HeaderRegistry): behavior is an interface (per CLAUDE.md), the holder is the global seam.
 */
export interface ApiCallContext {
    /**
     * True when there is a context to stamp into (a live Node RequestContext scope; a browser is always
     * active). {@link LogApiCall} throws if this is false — an api call with nowhere to tag is a bug.
     */
    isActive(): boolean;

    /**
     * Stamp one ContextKey → value into the ambient context. The logger reads it back off the context
     * (server: RequestContext.buildStructuredLogFields; browser: its own store) during the log emit.
     */
    // webpieces-disable no-any-unknown -- a context value is heterogeneous (the api struct here; strings elsewhere)
    set(contextKey: ContextKey, value: unknown): void;

    /**
     * Clear one ContextKey. {@link LogApiCall} calls set → log → remove as one SYNCHRONOUS span, so the
     * tag is never held across `await`. That is what makes a single browser global safe: single-threaded,
     * nothing can interleave between set and remove, so a concurrent call can never clobber the slot.
     */
    remove(contextKey: ContextKey): void;
}

/**
 * ApiCallContextHolder - the process-wide holder for the active {@link ApiCallContext}.
 *
 * Configured exactly like {@link LogManager}: the environment calls {@link ApiCallContextHolder.install}
 * at startup. Until then {@link get} THROWS, so a forgotten setup fails loudly rather than silently
 * dropping the `api` tag off every log line.
 */
export class ApiCallContextHolder {
    private static current: ApiCallContext | undefined;

    /** Install the environment's ApiCallContext (Node: RequestContext-backed; browser: module-global). */
    // webpieces-disable no-function-outside-class -- static global seam, configured once at startup (like LogManager.setFactory)
    static install(ctx: ApiCallContext): void {
        ApiCallContextHolder.current = ctx;
    }

    /** True once an ApiCallContext has been installed (used by tests to probe the unset state). */
    // webpieces-disable no-function-outside-class -- static global seam accessor (like HeaderRegistry.isConfigured)
    static isInstalled(): boolean {
        return ApiCallContextHolder.current !== undefined;
    }

    /**
     * The active ApiCallContext. Throws if nothing was installed — a one-time setup call is required:
     * `setupRuntime()` does it on a Node server; building `ClientHttpBrowserFactory` does it in a browser.
     */
    // webpieces-disable no-function-outside-class -- static global seam accessor (like LogManager/HeaderRegistry.get), not DI-injected
    static get(): ApiCallContext {
        if (!ApiCallContextHolder.current) {
            throw new Error(
                'ApiCallContext is not installed — LogApiCall cannot tag API-call logs. Set it up ONCE ' +
                'at startup: on a Node server, setupRuntime() installs it for you; in a browser, construct ' +
                'ClientHttpBrowserFactory once at startup. (This is the same one-time setup as ' +
                'HeaderRegistry.configure / LogManager.setFactory.)',
            );
        }
        return ApiCallContextHolder.current;
    }
}
