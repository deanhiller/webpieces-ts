/**
 * Header - Interface for HTTP header definitions.
 *
 * This interface is defined in core-util (lowest level package) to avoid
 * circular dependencies. core-context depends on this interface, while
 * http-api's PlatformHeader implements it.
 *
 * Dependency hierarchy:
 * - core-util (defines Header interface)
 * - core-context (uses Header interface)
 * - http-api (PlatformHeader implements Header)
 *
 * This allows RequestContext to work with headers without depending on
 * higher-level packages like http-api.
 */
export interface Header {
    /**
     * Get the HTTP header name (e.g., 'x-request-id', 'Authorization').
     * Also used as the key in RequestContext storage.
     */
    getHeaderName(): string;
}
