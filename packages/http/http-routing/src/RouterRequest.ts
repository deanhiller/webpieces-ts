/**
 * RouterRequest - Interface for HTTP request abstraction.
 *
 * Inspired by Java RouterRequest which provides a minimal abstraction
 * over the underlying HTTP stack (Express, Koa, raw Node.js http, etc.).
 *
 * This allows filters and routing logic to be independent of the HTTP server,
 * making them testable and portable.
 *
 * Implementations:
 * - ExpressRouterRequest (in @webpieces/http-server) - wraps Express Request
 * - TestRouterRequest (in tests) - mock for testing
 * - KoaRouterRequest (future) - wraps Koa Request
 *
 * For now, this is a minimal interface with just headers and basic info.
 * Future additions: cookies, queryParams, multiPartFields, body streaming, etc.
 */
export interface RouterRequest {
    /**
     * Get all HTTP headers as a Map.
     * Header names are lowercase per HTTP spec.
     *
     * @returns Map of header name (lowercase) -> header value
     */
    getHeaders(): Map<string, string>;

    /**
     * Get a single header value by name (case-insensitive).
     *
     * @param headerName - The header name (case-insensitive)
     * @returns The header value, or undefined if not present
     */
    getSingleHeaderValue(headerName: string): string | undefined;

    /**
     * Get the HTTP method (GET, POST, PUT, DELETE, etc.).
     */
    getMethod(): string;

    /**
     * Get the request path (e.g., '/api/users').
     */
    getPath(): string;

    /**
     * Read the request body as text.
     * Used by JsonFilter to parse JSON request body.
     *
     * @returns Promise of body text
     */
    readBody(): Promise<string>;
}
