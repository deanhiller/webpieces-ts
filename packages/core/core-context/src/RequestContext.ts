import { AsyncLocalStorage } from 'async_hooks';
import { ContextKey, HeaderRegistry, ServiceInfo } from '@webpieces/core-util';
import { HttpRequest } from './HttpRequest';

/** Reserved context key under which the current HttpRequest is stored. */
const HTTP_REQUEST_KEY = '__webpieces_http_request__';

/**
 * Context management using AsyncLocalStorage.
 * Similar to Java WebPieces Context class that uses ThreadLocal.
 *
 * This allows storing request-scoped data that is automatically available
 * throughout the async call chain, similar to MDC (Mapped Diagnostic Context).
 *
 * Example usage:
 * ```typescript
 * Context.put('REQUEST_ID', '12345');
 * await someAsyncOperation();
 * const id = Context.get('REQUEST_ID'); // Still available!
 * ```
 */
class RequestContextImpl {
    private storage: AsyncLocalStorage<Map<string, any>>;

    constructor() {
        this.storage = new AsyncLocalStorage<Map<string, any>>();
    }

    /**
     * Open THE request scope. A transport calls this once, at the beginning of a request.
     *
     * Nesting is a bug, not a feature, so it throws. AsyncLocalStorage would happily let a second
     * `run()` install a fresh empty Map that SHADOWS the outer one: every value the outer scope
     * holds becomes invisible, `fillFromRequest` mints a second request id, and the two halves of a
     * request end up in different traces. Nothing would tell you.
     *
     * With this guard the setup is right or it is loud. It mirrors
     * `RequestContextHeaders.fillFromRequest()`, which throws when there is NO active scope.
     *
     * @throws Error when a RequestContext is already active.
     */
    run<T>(fn: () => T): T {
        if (this.isActive()) {
            throw new Error(
                'RequestContext.run(...) called inside an active RequestContext. Nesting installs a ' +
                'fresh empty context that shadows the outer one: its values go invisible and a second ' +
                'request id is minted. Exactly ONE scope per request — the transport opens it.',
            );
        }
        // webpieces-disable no-any-unknown -- context values are heterogeneous (strings, recorder, meta objects)
        const store = new Map<string, any>();
        return this.storage.run(store, fn);
    }

    /**
     * Run a function with a specific context.
     */
    runWithContext<T>(context: Map<string, any>, fn: () => T): T {
        return this.storage.run(context, fn);
    }

    // webpieces-disable no-any-unknown -- context values are heterogeneous (strings, recorder, meta objects)
    getHeader<T = unknown>(key: ContextKey): T | undefined {
        return this.get<T>(key.name);
    }

    // webpieces-disable no-any-unknown -- context values are heterogeneous (strings, recorder, meta objects)
    putHeader(key: ContextKey, value: unknown): void {
        this.put(key.name, value);
    }

    /** Clear one context key. Used by the api-tag seam's set → log → remove span (see LogApiCall). */
    removeHeader(key: ContextKey): void {
        this.remove(key.name);
    }

    hasHeader(key: ContextKey): boolean {
        return this.has(key.name);
    }

    /**
    /**
     * Build the masked field map for LOGGING: every logged key in the global
     * {@link HeaderRegistry} read straight from this context, secured values
     * masked (via {@link ContextKey.maskIfSecured}), keyed by each key's `name`.
     *
     * Callers: RecordingFilter + NodeProxyClient.recordCall, which snapshot the context into a
     * test FIXTURE. The @webpieces/winston and @webpieces/bunyan backends also stamp these fields
     * onto every record, and they own the "log emitted outside RequestContext.run(...)" complaint —
     * reporting it HERE would recurse (the error line itself re-enters buildLogFields).
     *
     * Returns an EMPTY map outside a `run(...)` block rather than throwing: a fixture snapshot or a
     * log line is never worth crashing a request over.
     */
    buildLogFields(): Map<string, string> {
        const fields = new Map<string, string>();
        if (!this.isActive()) {
            return fields;
        }
        // The registry owns WHICH keys log (getLoggedKeys); we read each straight from THIS context
        // and each ContextKey masks its own secured value. String-only — this map feeds wire/MDC +
        // recorder fixtures — so an object-valued key (API_CALL_INFO) is guarded out by the
        // typeof-string check; objects ride buildStructuredLogFields instead. (Was a HeaderRegistry
        // method taking a read callback; only the server ever called it, so the seam was dead weight.)
        for (const key of HeaderRegistry.get().getLoggedKeys()) {
            const value = this.getHeader<string>(key);
            if (typeof value === 'string' && value) {
                fields.set(key.name, key.maskIfSecured(value));
            }
        }
        return fields;
    }

    /**
     * The STRUCTURED field map for the node logging backends: like {@link buildLogFields}, but values
     * may be OBJECTS, so an object-valued logged key ({@link WebpiecesCoreHeaders.API_CALL_INFO} holding
     * an {@link ApiCallInfo}) survives as an object and the winston/bunyan backends nest it into
     * `jsonPayload.api`. Reads values UNTYPED (not `<string>`) so the object comes through intact.
     *
     * Returns an EMPTY map outside a `run(...)` block (a log line is never worth crashing over) — same
     * as {@link buildLogFields}.
     *
     * PLUS this build's `version` from {@link ServiceInfo}. It is NOT a {@link ContextKey} — it is a
     * process-global identity fact, added HERE so every request log line of BOTH node backends
     * (winston/bunyan read this one map) says which build emitted it, with no per-backend duplication.
     * Read via the non-throwing {@link ServiceInfo.getVersion}, so it is simply ABSENT until
     * `setInfo` has run — logging keeps working before the service is identified, then `version`
     * starts appearing. A caller-set `version` header (there is none by convention) would be
     * overwritten here; that is intentional — the build version is authoritative.
     */
    buildStructuredLogFields(): Map<string, string | object> {
        const fields = new Map<string, string | object>();
        if (!this.isActive()) {
            return fields;
        }
        // Like buildLogFields, but values may be OBJECTS (API_CALL_INFO): read UNTYPED so the object
        // survives and winston/bunyan nest it into jsonPayload.<name>. Secured STRING values are still
        // masked per key; non-string primitives are ignored rather than String()-flattened. (Inlined
        // from HeaderRegistry for the same reason as buildLogFields — only the server called it.)
        for (const key of HeaderRegistry.get().getLoggedKeys()) {
            const value = this.getHeader(key);
            if (value === undefined || value === null) {
                continue;
            }
            if (typeof value === 'string') {
                if (value) {
                    fields.set(key.name, key.maskIfSecured(value));
                }
            } else if (typeof value === 'object') {
                fields.set(key.name, value);
            }
        }
        // PLUS this build's `version` from ServiceInfo — NOT a ContextKey, a process-global identity
        // fact, added HERE so every request log line of BOTH node backends (they read this one map)
        // says which build emitted it, with no per-backend duplication. Non-throwing read: simply
        // ABSENT until setInfo has run, so logging works before the service is identified, then
        // `version` starts appearing.
        const version = ServiceInfo.getVersion();
        if (version) {
            fields.set('version', version);
        }
        return fields;
    }


    /**
     * Store the transport-neutral {@link HttpRequest} for this request. Called once, above the
     * api boundary, by whichever transport is driving the router (the express adapter, or the
     * in-process client). Filters/auth read it back via {@link getRequest} so they never touch
     * express — the same chain then runs over HTTP and in-process.
     */
    setRequest(request: HttpRequest): void {
        this.put(HTTP_REQUEST_KEY, request);
    }

    /** The current {@link HttpRequest}, or undefined if none was set for this context. */
    getRequest(): HttpRequest | undefined {
        return this.get<HttpRequest>(HTTP_REQUEST_KEY);
    }

    // webpieces-disable no-any-unknown -- context values are heterogeneous (strings, recorder, meta objects)
    getHeaders(keys: ContextKey[]): unknown[] {
        return keys.map(key => this.getHeader(key));
    }

    /**
     * Store a value in the current context.
     */
    put(key: string, value: any): void {
        const store = this.storage.getStore();
        if (!store) {
            throw new Error('No context available. Did you call Context.run() first?');
        }
        store.set(key, value);
    }

    /**
     * Retrieve a value from the current context.
     */
    get<T = any>(key: string): T | undefined {
        const store = this.storage.getStore();
        return store?.get(key);
    }

    /**
     * Remove a value from the current context.
     */
    remove(key: string): void {
        const store = this.storage.getStore();
        store?.delete(key);
    }

    /**
     * Clear all values from the current context.
     */
    clear(): void {
        const store = this.storage.getStore();
        store?.clear();
    }

    /**
     * Copy the current context to a new Map.
     * Used by XPromise to preserve context across async boundaries.
     */
    copyContext(): Map<string, any> {
        const store = this.storage.getStore();
        if (!store) {
            return new Map();
        }
        return new Map(store);
    }

    /**
     * Set the entire context from a Map.
     * Used by XPromise to restore context.
     */
    setContext(context: Map<string, any>): void {
        const store = this.storage.getStore();
        if (!store) {
            throw new Error('No context available. Did you call Context.run() first?');
        }
        store.clear();
        context.forEach((value, key) => {
            store.set(key, value);
        });
    }

    /**
     * Get all context entries.
     */
    getAll(): Map<string, any> {
        const store = this.storage.getStore();
        return store ? new Map(store) : new Map();
    }

    /**
     * Check if a key exists in the context.
     */
    has(key: string): boolean {
        const store = this.storage.getStore();
        return store?.has(key) ?? false;
    }

    /**
     * Check if RequestContext is currently active.
     * Returns true if we're inside a RequestContext.run() block, false otherwise.
     *
     * Useful for tests to verify context is set up before making API calls.
     */
    isActive(): boolean {
        return this.storage.getStore() !== undefined;
    }

}



/**
 * Global singleton instance of RequestContext.
 * Use this throughout your application.
 */
export const RequestContext = new RequestContextImpl();
