import { Header } from './Header';

/**
 * ContextKey - Typed key for non-HTTP context values stored in RequestContext.
 *
 * Similar to PlatformHeader but for context-only values that don't correspond
 * to HTTP headers (e.g., METHOD_META, REQUEST_PATH).
 *
 * Customers can define their own ContextKey instances for app-specific values.
 *
 * Usage:
 * ```typescript
 * const MY_KEY = new ContextKey('my-app-key');
 * RequestContext.putHeader(MY_KEY, someValue);
 * const value = RequestContext.getHeader(MY_KEY);
 * ```
 */
export class ContextKey implements Header {
    constructor(private readonly keyName: string) {}

    getHeaderName(): string {
        return this.keyName;
    }
}
