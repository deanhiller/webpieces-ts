import { PlatformHeader } from './PlatformHeader';
import {RequestContext} from "@webpieces/core-context";


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

/**
 * HeaderMethods - Utility class for working with platform headers.
 *
 * This class can be injected in both server (Node.js) and client (Angular/browser) environments.
 * It provides common operations for filtering and processing headers.
 *
 * Pattern: Stateless utility class (pure functions, can be instantiated or injected)
 * - Server: Can inject empty instance, use static-like methods
 * - Client: new HeaderMethods() (no DI needed)
 *
 * Usage:
 * ```typescript
 * // Server-side (ContextFilter)
 * constructor(@inject() headerMethods: HeaderMethods) {
 *     const allHeaders = [... flatten from extensions ...];
 *     this.transferHeaders = headerMethods.findTransferHeaders(allHeaders);
 * }
 *
 * // Client-side (ClientFactory)
 * const headerMethods = new HeaderMethods();
 * const loggableHeaders = headerMethods.findLoggableHeaders(allHeaders, requestHeaders);
 * ```
 */
export class HeaderMethods {
    /**
     * Filter headers to only those that should be transferred (isWantTransferred=true).
     *
     * @param headers - Array of PlatformHeader definitions
     * @returns Filtered array of headers with isWantTransferred=true
     */
    findTransferHeaders(headers: PlatformHeader[]): PlatformHeader[] {
        return headers.filter(h => h.isWantTransferred);
    }

    /**
     * Split headers into secure and public categories.
     *
     * @param headers - Array of PlatformHeader definitions
     * @returns SplitHeaders with secureHeaders (isSecured=true) and publicHeaders (isSecured=false)
     */
    secureHeaders(headers: PlatformHeader[]): PlatformHeader[] {
        return headers.filter(h => h.isSecured);
    }

    /**
     * Get all headers that should be logged.
     * All headers are loggable - secure headers will be masked by formatHeadersForLogging.
     *
     * @param headers - Array of PlatformHeader definitions
     * @returns All headers (they're all loggable, just some are masked)
     */
    findLoggableHeaders(headers: PlatformHeader[]): PlatformHeader[] {
        return headers; // All headers are loggable, secure ones will be masked
    }

    buildSecureMapForLogs(platformHeaders: PlatformHeader[], contextReader: ContextReader): Map<string, any> {
        const headers = new Map<string, any>();

        for (const header of platformHeaders) {
            const value = contextReader.read(header);
            if(value) {
                if(!header.isSecured)
                    headers.set(header.headerName, value);
                else
                    headers.set(header.headerName, this.maskSecureValue(value));
            }
        }

        return headers;
    }

    /**
     * Format headers for logging with secure masking.
     * Takes filtered PlatformHeaders and actual header values from request.
     *
     * Masking rules for secure headers (isSecured=true):
     * - Length > 15: Show first 3 and last 3 characters with "..." between
     * - Length 8-15: Show first 2 characters with "..."
     * - Length < 8: Show "<secure key too short to log>"
     *
     * @param loggableHeaders - Filtered PlatformHeaders to log
     * @param headerMap - Map of header name (lowercase) -> array of values from request
     * @returns Record of header name -> masked or full value for logging
     */
    formatHeadersForLogging(loggableHeaders: PlatformHeader[], headerMap: Map<string, string[]>): Record<string, string> {
        const result: Record<string, string> = {};

        for (const platformHeader of loggableHeaders) {
            // Look for header in the map (case-insensitive)
            const values = headerMap.get(platformHeader.headerName.toLowerCase());
            if (!values || values.length === 0) {
                continue;
            }

            const value = values[0]; // Take first value

            if (platformHeader.isSecured) {
                result[platformHeader.headerName] = this.maskSecureValue(value);
            } else {
                result[platformHeader.headerName] = value;
            }
        }

        return result;
    }

    /**
     * Mask a secure header value based on its length.
     *
     * @param value - The secure header value to mask
     * @returns Masked value
     */
    private maskSecureValue(value: string): string {
        const len = value.length;

        if (len < 8) {
            return '<secure key too short to log>';
        } else if (len <= 15) {
            // 8-15 characters: show first 2 + "..."
            return `${value.substring(0, 2)}...`;
        } else {
            // > 15 characters: show first 3 + "..." + last 3
            return `${value.substring(0, 3)}...${value.substring(len - 3)}`;
        }
    }
}


