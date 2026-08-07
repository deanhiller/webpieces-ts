import { AnyContextKey, AnyUntrustedContextKey, ContextReader } from '@webpieces/core-util';

/**
 * MutableContextStore - the BROWSER ContextReader.
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
export class MutableContextStore implements ContextReader {
    private values: Map<string, string> = new Map();

    /**
     * Set (or overwrite) the current value for a context key. UNTRUSTED keys only, by type. A browser cannot PROVE anything — every value in here was typed
     * by the app or the user — so a store that accepted a trusted key would be a forgery side door,
     * exactly the one closed on the {@link ApiCallContext} seam. Narrowing it here makes the mistake
     * a compile error in the browser bundle instead of a 401 at the far end of an HTTP call.
     */
    set(key: AnyUntrustedContextKey, value: string): void {
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

    read(key: AnyContextKey): string | undefined {
        return this.values.get(key.name);
    }
}
