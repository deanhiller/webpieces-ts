/**
 * RouterResponse - Interface for HTTP response abstraction.
 *
 * Inspired by Java RouterResponse which provides a minimal abstraction
 * over the underlying HTTP stack.
 *
 * This allows filters and routing logic to write responses without
 * depending on the HTTP server implementation.
 *
 * Implementations:
 * - ExpressRouterResponse (in @webpieces/http-server) - wraps Express Response
 * - TestRouterResponse (in tests) - mock for testing
 * - KoaRouterResponse (future) - wraps Koa Response
 *
 * For now, minimal interface with status, headers, and body.
 * Future: streaming, cookies, redirects, etc.
 */
export interface RouterResponse {
    /**
     * Set HTTP status code.
     *
     * @param code - HTTP status code (200, 404, 500, etc.)
     */
    setStatus(code: number): void;

    /**
     * Set a response header.
     *
     * @param name - Header name
     * @param value - Header value
     */
    setHeader(name: string, value: string): void;

    /**
     * Send response body and end the response.
     *
     * @param body - Response body (usually JSON string)
     */
    send(body: string): void;

    /**
     * Check if headers have already been sent.
     * Used to prevent double-sending responses.
     */
    isHeadersSent(): boolean;
}
