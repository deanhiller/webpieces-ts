import { PlatformHeader, ContextReader } from '@webpieces/http-api';

/**
 * MutableContextStore - Browser-side context store + ContextReader.
 *
 * Browsers have no AsyncLocalStorage, so apps (Angular/React) hold one of these
 * (e.g. as an Angular service / React context value) and set header values as
 * they become known (login token, selected tenant, ...). The ContextMgr then
 * reads from it on every outbound request.
 *
 * Example (Angular):
 * ```typescript
 * const store = new MutableContextStore();
 * const registry = new HeaderRegistry([new PlatformHeadersExtension(CompanyHeaders.getAllHeaders())]);
 * const config = new ClientConfig(baseUrl, new ContextMgr(store, registry));
 * const client = createApiClient(SaveApi, config);
 *
 * // later, when the user logs in / picks a tenant:
 * store.set(WebpiecesCoreHeaders.AUTHORIZATION, token);
 * store.set(CompanyHeaders.TENANT_ID, tenantId);
 * ```
 */
export class MutableContextStore implements ContextReader {
    private values: Map<string, string> = new Map();

    /**
     * Set (or overwrite) the current value for a header.
     */
    set(header: PlatformHeader, value: string): void {
        this.values.set(header.headerName, value);
    }

    /**
     * Remove the current value for a header (e.g. on logout).
     */
    remove(header: PlatformHeader): void {
        this.values.delete(header.headerName);
    }

    /**
     * Clear all stored values.
     */
    clear(): void {
        this.values.clear();
    }

    read(header: PlatformHeader): string | undefined {
        return this.values.get(header.headerName);
    }
}
