import { AsyncLocalStorage } from 'async_hooks';

//some stuff here
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
     * Run a function with a new context.
     * This is typically called at the beginning of a request.
     */
    run<T>(fn: () => T): T {
        const store = new Map<string, any>();
        return this.storage.run(store, fn);
    }

    /**
     * Run a function with a specific context.
     */
    runWithContext<T>(context: Map<string, any>, fn: () => T): T {
        return this.storage.run(context, fn);
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

    /**
     * Store a platform header value in the context.
     * Uses HEADER_ prefix to avoid collisions with regular context keys.
     *
     * Called by ExpressWrapper.transferHeaders() to store incoming HTTP headers.
     * Called by controllers/filters to set headers for downstream services.
     *
     * @param header - The platform header definition
     * @param value - The header value from the HTTP request
     */
    putHeader(header: PlatformHeader, value: string): void {
        // Use HEADER_ prefix to namespace headers separately from other context data
        const key = `HEADER_${header.headerName}`;
        this.put(key, value);
    }

    /**
     * Retrieve a platform header value from the context.
     *
     * Used by:
     * - Controllers/filters to read incoming headers
     * - RequestContextReader (client-side) to propagate headers to downstream calls
     *
     * @param header - The platform header definition
     * @returns The header value, or undefined if not set
     */
    getHeader(header: PlatformHeader): string | undefined {
        const key = `HEADER_${header.headerName}`;
        return this.get<string>(key);
    }

    /**
     * Check if a platform header is present in the context.
     *
     * @param header - The platform header definition
     * @returns true if header is set, false otherwise
     */
    hasHeader(header: PlatformHeader): boolean {
        const key = `HEADER_${header.headerName}`;
        return this.has(key);
    }

    /**
     * Get all headers stored in the context.
     * Returns a Map of header names to values.
     *
     * Useful for:
     * - Debugging (inspect all headers)
     * - Logging (log all request headers)
     * - Response headers (echo headers back to client)
     *
     * @returns Map of header names (without HEADER_ prefix) to values
     */
    getAllHeaders(): Map<string, string> {
        const headers = new Map<string, string>();
        const store = this.storage.getStore();

        if (store) {
            for (const [key, value] of store.entries()) {
                // Only include keys with HEADER_ prefix
                if (key.startsWith('HEADER_')) {
                    const headerName = key.substring('HEADER_'.length);
                    // Only include string values (headers are always strings)
                    if (typeof value === 'string') {
                        headers.set(headerName, value);
                    }
                }
            }
        }

        return headers;
    }
}

// Import PlatformHeader type for type annotations
// Note: This is a type-only import to avoid circular dependencies
import type { PlatformHeader } from '@webpieces/http-api';

/**
 * Global singleton instance of RequestContext.
 * Use this throughout your application.
 */
export const RequestContext = new RequestContextImpl();
