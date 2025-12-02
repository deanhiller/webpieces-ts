/**
 * WebpiecesServer - Public interface for WebPieces server.
 *
 * This interface exposes only the methods needed by application code:
 * - start(): Start the HTTP server
 * - stop(): Stop the HTTP server
 *
 * The initialization logic is hidden inside WebpiecesFactory.create().
 * This provides a clean API and prevents accidental re-initialization.
 *
 * Usage:
 * ```typescript
 * const server = WebpiecesFactory.create(new ProdServerMeta());
 * await server.start(8080);
 * console.log('Server is now listening!');
 * // ... later
 * server.stop();
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
     */
    stop(): void;
}
