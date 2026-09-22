import { AnyContextKey, AnyUntrustedContextKey, ContextStore } from '@webpieces/core-util';

/**
 * MutableContextStore - the BROWSER ContextStore (read AND write).
 *
 * Browsers have no AsyncLocalStorage, so apps (Angular/React) hold one of these
 * (e.g. as an Angular service / React context value) and set values as they become
 * known (login token, selected tenant, ...). The ContextMgr then reads from it on
 * every outbound request.
 *
 * Example (Angular):
 * ```typescript
 * const store = new MutableContextStore();
 * // startup:
 * HeaderRegistry.configure(CompanyHeaders.ALL_HEADERS, true);
 * const factory = new ClientHttpFactory(new ContextMgr(store));
 * const client = factory.createRpcClient(SaveApi, new ClientConfig('server'));
 *
 * // later, when the user logs in / picks a tenant:
 * store.set(AppHeaders.AUTHORIZATION, token);   // an app-defined key, if it wants auto-attach
 * store.set(CompanyHeaders.TENANT_ID, tenantId);
 * ```
 */
export class MutableContextStore implements ContextStore {
    // webpieces-disable no-any-unknown -- heterogeneous by construction: a scalar key holds a string, a `collect` response key holds a list
    private values: Map<string, unknown> = new Map();

    /**
     * Set (or overwrite) the current value for a context key. UNTRUSTED keys only, by type. A browser cannot PROVE anything — every value in here was typed
     * by the app or the user — so a store that accepted a trusted key would be a forgery side door,
     * exactly the one closed on the {@link ApiCallContext} seam. Narrowing it here makes the mistake
     * a compile error in the browser bundle instead of a 401 at the far end of an HTTP call.
     *
     * `value` is `unknown` because this is also the write side {@link ContextMgr.acceptResponseHeaders}
     * uses, and a `collect` response key accumulates a LIST. {@link read} keeps its string return and
     * simply does not see those — a list has no single outbound header value.
     */
    // webpieces-disable no-any-unknown -- see the values map above
    set(key: AnyUntrustedContextKey, value: unknown): void {
        this.values.set(key.name, value);
    }

    /** Remove the current value for a context key (e.g. on logout). */
    remove(key: AnyUntrustedContextKey): void {
        this.values.delete(key.name);
    }

    /** Clear all stored values. */
    clear(): void {
        this.values.clear();
    }

    /**
     * The string value, or undefined. A non-string (a `collect` key's list) reads as ABSENT rather
     * than being coerced: this feeds the outbound header builder, and `['a','b'].toString()` on the
     * wire would be a silently wrong header.
     */
    read(key: AnyContextKey): string | undefined {
        const value = this.values.get(key.name);
        return typeof value === 'string' ? value : undefined;
    }

    /** The raw stored value, whatever its type — the merge path's read half. */
    // webpieces-disable no-any-unknown -- see the values map above
    readValue(key: AnyContextKey): unknown {
        return this.values.get(key.name);
    }
}
