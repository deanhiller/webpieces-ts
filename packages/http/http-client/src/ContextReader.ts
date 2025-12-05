import { PlatformHeader, ContextReader } from '@webpieces/http-api';

/**
 * StaticContextReader - Returns static header values from a Map.
 *
 * Useful for:
 * - Browser environments where headers are manually managed
 * - Testing with fixed header values
 * - Angular services that read from localStorage/sessionStorage
 *
 * Example:
 * ```typescript
 * const headers = new Map<string, string>();
 * headers.set('x-api-version', 'v1');
 * headers.set('Authorization', getAuthToken());
 * const reader = new StaticContextReader(headers);
 * ```
 */
export class StaticContextReader implements ContextReader {
    constructor(private headers: Map<string, string>) {}

    read(header: PlatformHeader): string | undefined {
        return this.headers.get(header.headerName);
    }
}

/**
 * CompositeContextReader - Tries multiple readers in order.
 *
 * Later readers override earlier ones (last one wins).
 * Useful for layered header sources:
 * 1. RequestContext (base layer, from incoming request)
 * 2. Config headers (middle layer, from ClientConfig)
 * 3. Dynamic headers (top layer, runtime-computed values)
 *
 * Example:
 * ```typescript
 * const reader = new CompositeContextReader([
 *     new RequestContextReader(),      // Try context first
 *     new StaticContextReader(config), // Fall back to config
 * ]);
 * ```
 */
export class CompositeContextReader implements ContextReader {
    constructor(private readers: ContextReader[]) {}

    read(header: PlatformHeader): string | undefined {
        // Try readers in reverse order (last one wins/overrides)
        for (let i = this.readers.length - 1; i >= 0; i--) {
            const value = this.readers[i].read(header);
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }
}
