import { ApiCallContext, ContextKey } from '@webpieces/core-util';

/**
 * BrowserApiCallContext - the BROWSER implementation of the {@link ApiCallContext} seam, so
 * {@link LogApiCall} (shared, browser-safe core-util) stamps its structured `api` tag in the browser
 * too. Installed by {@link ClientHttpBrowserFactory}.
 *
 * WHY a module-level global is SAFE here (no AsyncLocalStorage / Zone.js): {@link LogApiCall} stamps as
 * `set → log → remove` in ONE synchronous span, so the slot is only ever populated while the logger reads
 * it and is cleared before the `await fetch`. A browser is single-threaded, so nothing can interleave
 * between set and remove — a concurrent in-flight call can never clobber the slot. (Because of that, only
 * the `[API-*]` req/resp lines carry `api`, not lines emitted mid-fetch — exactly the filter surface.)
 *
 * READ side: the object-valued `api` tag cannot ride the string-only MutableContextStore, so a
 * downstream browser/Angular logger reads it here via {@link BrowserApiCallContext.snapshot} DURING its
 * log emit (inside the set → remove span) and folds `api.{side,type,result,...}` into that line.
 */
export class BrowserApiCallContext implements ApiCallContext {
    // Shared across every instance (a browser app may build the factory more than once) so the value a
    // logger reads is the same one LogApiCall stamped, whichever instance the holder currently holds.
    // webpieces-disable no-any-unknown -- context values are heterogeneous (the api struct; future keys)
    private static readonly store = new Map<string, unknown>();

    /** Always active in the browser — there is always the single global slot per key to stamp into. */
    isActive(): boolean {
        return true;
    }

    // webpieces-disable no-any-unknown -- a context value is heterogeneous (the api struct here; strings elsewhere)
    set(contextKey: ContextKey, value: unknown): void {
        BrowserApiCallContext.store.set(contextKey.name, value);
    }

    remove(contextKey: ContextKey): void {
        BrowserApiCallContext.store.delete(contextKey.name);
    }

    /**
     * The current stamped values, keyed by ContextKey name — for a browser logger to fold into each line.
     */
    // webpieces-disable no-any-unknown -- context values are heterogeneous (the api struct; future keys)
    // webpieces-disable no-function-outside-class -- static read accessor of the module-global browser slot (like ApiCallContextHolder), read by a browser logger, not DI-injected
    static snapshot(): ReadonlyMap<string, unknown> {
        return BrowserApiCallContext.store;
    }
}
