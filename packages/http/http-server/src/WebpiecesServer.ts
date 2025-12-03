import { Container } from 'inversify';

/**
 * WebpiecesServer - Public interface for WebPieces server.
 *
 * This interface exposes the methods needed by application code:
 * - start(): Start the HTTP server
 * - stop(): Stop the HTTP server
 * - createApiClient(): Create API client proxy for testing (no HTTP!)
 * - getContainer(): Access DI container for verification
 *
 * The initialization logic is hidden inside WebpiecesFactory.create().
 * This provides a clean API and prevents accidental re-initialization.
 *
 * Usage:
 * ```typescript
 * // Production
 * const server = WebpiecesFactory.create(new ProdServerMeta());
 * await server.start(8080);
 *
 * // Testing (no HTTP needed!)
 * const server = WebpiecesFactory.create(new ProdServerMeta(), overrides);
 * const api = server.createApiClient(SaveApiPrototype);
 * const response = await api.save(request);
 * ```
 */
export interface WebpiecesServer {
    /**
     * Start the HTTP server with Express.
     * Returns a Promise that resolves when the server is listening,
     * or rejects if the server fails to start.
     *
     * @param port - The port to listen on (default: 8080)
     * @returns Promise that resolves when server is ready
     */
    start(port?: number): Promise<void>;

    /**
     * Stop the HTTP server.
     * Returns a Promise that resolves when the server is stopped,
     * or rejects if there's an error stopping the server.
     *
     * @returns Promise that resolves when server is stopped
     */
    stop(): Promise<void>;

    /**
     * Create an API client proxy for testing.
     *
     * This creates a client that routes calls through the full filter chain
     * and controller, but WITHOUT any HTTP overhead. Perfect for testing!
     *
     * The client uses the ApiPrototype class to discover routes via decorators,
     * then invokes the corresponding controller method through the filter chain.
     *
     * @param apiPrototype - The API prototype class with routing decorators (can be abstract)
     * @returns A proxy that implements the API interface
     *
     * Example:
     * ```typescript
     * const saveApi = server.createApiClient<SaveApi>(SaveApiPrototype);
     * const response = await saveApi.save(request);
     * ```
     */
    createApiClient<T>(apiPrototype: abstract new (...args: any[]) => T): T;

    /**
     * Get the application DI container.
     *
     * Useful for testing to verify state or access services directly.
     *
     * @returns The application Container
     */
    getContainer(): Container;
}
