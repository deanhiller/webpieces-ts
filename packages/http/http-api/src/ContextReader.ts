import { PlatformHeader } from './PlatformHeader';

/**
 * ContextReader - Interface for reading header values from context.
 *
 * Different implementations for different environments:
 * - RequestContextReader: Node.js with AsyncLocalStorage (in @webpieces/http-routing, server-side only)
 * - StaticContextReader: Browser or testing with manual header management (in @webpieces/http-client)
 * - CompositeContextReader: Combines multiple readers with priority (in @webpieces/http-client)
 *
 * This interface is defined in @webpieces/http-api so both http-routing and http-client
 * can use it without creating circular dependencies.
 *
 * This interface is DI-independent so it works in both server (Inversify)
 * and client (Angular, browser) environments.
 */
export interface ContextReader {
    /**
     * Read the value of a platform header.
     * Returns undefined if header not available.
     *
     * @param header - The platform header to read
     * @returns The header value, or undefined if not present
     */
    read(header: PlatformHeader): string | undefined;
}
